/** Test-owned public Host.execFile wrapper. Product permission/QC/generation
 * gates stay in place. Rehearsal substitutes remote transport only; live mode
 * forwards exact approved GitHub operations and injects a lost reply afterwards. */
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {basename,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assertTrialIdentity,assertFixtureChanges,SHA,fail} from './hosted-e2e-contract.mjs';
const ok=(stdout='')=>({exitCode:0,signal:null,stdout,stderr:'',stdoutTruncated:false,stderrTruncated:false});
const valid=r=>r.exitCode===0&&!r.signal&&!r.stdoutTruncated&&!r.stderrTruncated;
export function wrapAcceptanceExec(exec,trial){
 assertTrialIdentity(trial);
 const snapshot=()=>{
  if(!trial.controlDataDirectory)return undefined; // standalone synthetic transport tests
  const db=new DatabaseSync(join(trial.controlDataDirectory,'autopilot.sqlite'),{readOnly:true,allowExtension:false});
  try{return JSON.stringify(db.prepare('SELECT scope,workflow_id,enabled,generation FROM autopilots ORDER BY scope,workflow_id').all());}
  finally{db.close();}
 };
 const load=()=>JSON.parse(readFileSync(trial.transport,'utf8'));
 const save=s=>{const temp=trial.transport+'.next';writeFileSync(temp,JSON.stringify(s),{mode:0o600});renameSync(temp,trial.transport);};
 const update=fn=>{const s=load();fn(s);save(s);return s;};
 const inspectDelta=async(r,sha)=>{
  if(!SHA.test(sha))fail('unexpected-source-change');
  const p=await exec({...r,file:'/usr/bin/git',args:['-C',r.cwd??r.args[1],'diff','--name-only',trial.seedSha,sha,'--']});
  if(!valid(p))fail('source-inspection-failed');
  assertFixtureChanges(p.stdout.trim().split('\n').filter(Boolean),trial.fixture);
 };
 const count=key=>update(s=>{s[key]=(s[key]??0)+1;if(s[key]>1)fail('duplicate-remote-mutation');});
 const canonical='https://github.com/'+trial.repository+'.git';
 const inspectPr=p=>{
  if(!p||p.baseRefName!==trial.base||p.headRefName!==undefined&&p.headRefName!==trial.head||
    !SHA.test(p.headRefOid??'')||!Number.isSafeInteger(p.number)||p.number<1||
    p.url!=='https://github.com/'+trial.repository+'/pull/'+p.number)fail('remote-identity-refused');
  update(s=>{if(s.prNumber&&s.prNumber!==p.number)fail('remote-identity-refused');s.prNumber=p.number;s.headSha=p.headRefOid;});
 };
 const lose=key=>{update(s=>{s[key]=true;});throw new Error('Synthetic test lost '+key+' reply; inspect persisted remote state');};
 return async request=>{
  const args=[...(request.args??[])],file=basename(request.file);
  request.signal.throwIfAborted();
  const generation=snapshot();
  const mutate=r=>{r.signal.throwIfAborted();if(snapshot()!==generation)fail('operator-generation-changed');return exec(r);};
  if(file==='git'&&(args.includes('push')||args.includes('ls-remote'))){
   if(args[0]!=='-C'||!args.includes(canonical))fail('remote-identity-refused');
   const pushing=args.includes('push');
   if(pushing){
    const refspec=args.at(-1),match=/^([a-f0-9]{40}):refs\/heads\/(.+)$/.exec(refspec??'');
    if(!match||match[2]!==trial.head||args.includes('--force')||args.includes('--delete'))fail('remote-identity-refused');
    await inspectDelta(request,match[1]);count('pushCalls');update(s=>{s.headSha=match[1];});
   }else if(args.at(-1)!=='refs/heads/'+trial.head)fail('remote-identity-refused');
   const forwarded=trial.mode==='rehearsal'?{...request,args:args.map(a=>a===canonical?trial.bare:a)}:request;
   const r=await (pushing?mutate(forwarded):exec(forwarded));
   if(pushing&&valid(r))lose('pushReplyLost');
   return r;
  }
  if(file!=='gh')return exec(request);
  const repoAt=args.findIndex(a=>a==='--repo'||a==='-R');
  const api=args[0]==='api'?args.find(a=>a.startsWith('repos/')):undefined;
  if((api?api.split('/').slice(1,3).join('/'):args[repoAt+1])!==trial.repository)fail('remote-identity-refused');
  const operation=args.slice(0,2).join(' ');
  let state=load();
  if(operation==='pr list'){
   if(args[args.indexOf('--head')+1]!==trial.head)fail('remote-identity-refused');
   if(trial.mode==='rehearsal')return ok(JSON.stringify(state.pr?[state.pr]:[]));
   const r=await exec(request);if(valid(r)){const prs=JSON.parse(r.stdout);if(prs.length>1)fail('remote-identity-refused');for(const p of prs)inspectPr(p);}
   return r;
  }
  if(operation==='pr create'){
   if(args[args.indexOf('--base')+1]!==trial.base||args[args.indexOf('--head')+1]!==trial.head||!args.includes('--draft'))
    fail('remote-identity-refused');
   count('createCalls');
   if(trial.mode==='rehearsal'){
    state=update(s=>{s.pr={number:1,url:'https://github.com/'+trial.repository+'/pull/1',headRefName:trial.head,
      baseRefName:trial.base,headRefOid:s.headSha,isDraft:true,state:'OPEN',autoMergeRequest:null};s.prNumber=1;});
    return ok(state.pr.url+'\n');
   }
   return mutate(request);
  }
  if(operation==='pr view'){
   const n=Number(args[2]);if(n!==state.prNumber)fail('remote-identity-refused');
   if(trial.mode==='rehearsal')return ok(JSON.stringify(state.pr));
   const r=await exec(request);if(valid(r))inspectPr(JSON.parse(r.stdout));return r;
  }
  if(operation==='pr checks'){
   if(Number(args[2])!==state.prNumber)fail('remote-identity-refused');
   return trial.mode==='rehearsal'?ok(JSON.stringify([{name:'explicitly-simulated-rehearsal-check',bucket:'pass'}])):exec(request);
  }
  if(operation==='pr ready'){
   if(Number(args[2])!==state.prNumber)fail('remote-identity-refused');count('readyCalls');
   if(trial.mode==='rehearsal'){update(s=>{s.pr.isDraft=false;});return ok();}
   return mutate(request);
  }
  if(api?.startsWith('repos/'+trial.repository+'/actions/runs?')){
   if(args.includes('--method')||trial.mode!=='live')fail('remote-operation-refused');return exec(request);
  }
  if(api==='repos/'+trial.repository+'/pulls/'+state.prNumber+'/merge'){
   if(args[args.indexOf('--method')+1]!=='PUT'||!args.includes('sha='+state.headSha)||
     !args.includes('merge_method=merge')||args.includes('--admin')||args.includes('--auto'))fail('remote-operation-refused');
   await inspectDelta(request,state.headSha);count('mergeCalls');
   let r;
   if(trial.mode==='rehearsal'){
    const checked=await mutate({...request,file:'/usr/bin/git',args:['--git-dir='+trial.bare,'update-ref','refs/heads/'+trial.base,state.headSha,trial.seedSha]});
    if(!valid(checked))return checked;
    update(s=>{s.pr.state='MERGED';s.mergeSha=s.headSha;});
    r=ok('HTTP/2.0 200 OK\r\n\r\n'+JSON.stringify({merged:true,sha:state.headSha}));
   }else r=await mutate(request);
   if(valid(r)&&/^HTTP\/[0-9.]+\s+200\b/m.test(r.stdout)){
    try{const body=JSON.parse(r.stdout.split(/\r?\n\r?\n/).slice(1).join('\n\n'));if(body.merged&&SHA.test(body.sha))update(s=>{s.mergeSha=body.sha;});}catch{}
    lose('mergeReplyLost');
   }
   return r;
  }
  fail('remote-operation-refused');
 };
}
