/** Actual shipped PI WEB executables and public package/browser API adapters.
 * Only temporary test processes are stopped. No installed services are touched. */
import {mkdirSync,writeFileSync,symlinkSync,copyFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {REPO_ROOT} from './e2e-contract.mjs';
import {MODEL,fail} from './hosted-e2e-contract.mjs';
import {descendants,isStillRunning,signalRecorded} from './hosted-e2e-processes.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise((r,j)=>s.once('error',j).listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function launchHost(trial,{root,project,authFile,ghConfig}){
 const make=n=>{const p=join(root,n);mkdirSync(p,{recursive:true,mode:0o700});return p;};
 const home=make('home'),state=make('state'),agent=make('agent'),sessions=make('sessions'),adapter=make('adapter');
 const browserRoot=make('adapter/browser'),gatewayPort=await port(),socket=join(root,'sessiond.sock');
 const serverDir=join(REPO_ROOT,'node_modules/@jmfederico/pi-web/dist/server');
 const children=[],connections=new Set(),recorded=new Map();let daemon,web,browser,proxy,context,page,closing;
 const remember=()=>{for(const [pid,r] of descendants(process.pid))recorded.set(pid,r);};
 const tracking=setInterval(remember,200);tracking.unref();
 const testOperations=['list','get','create','auto.status','auto.configure','auto.start','auto.pause',
  'auto.permissions','auto.permission.decide','agents.list','agents.command','agents.history','security.readiness'];
 for(const file of ['browser.js','fleet.js','canvas-layout.js','canvas-preferences.js'])
  copyFileSync(join(REPO_ROOT,'dist/pi-web',file),join(browserRoot,file));
 writeFileSync(join(browserRoot,'entry.js'),`import base from './browser.js';\nexport default {...base,activate(api){\n const live=base.activate(api);\n const panels=live.contributions.workspacePanels.map(panel=>({...panel,render(ctx){\n  window.__mmAcceptance={projectId:ctx.workspace.projectId,workspaceId:ctx.workspace.id,\n   request:(op,input)=>{if(!${JSON.stringify(testOperations)}.includes(op))throw Error('Unsupported test operation');return ctx.peer.request(op,input);}};\n  return panel.render(ctx);\n }}));\n return {...live,contributions:{...live.contributions,workspacePanels:panels}};\n}};\n`,{mode:0o600});
 const trialPath=join(root,'trial.json');writeFileSync(trialPath,JSON.stringify(trial),{mode:0o600});
 const imported=file=>JSON.stringify(pathToFileURL(join(REPO_ROOT,file)).href);
 writeFileSync(join(adapter,'server.mjs'),`import base from ${imported('dist/pi-web/server.js')};\nimport {readFileSync} from 'node:fs';\nimport {wrapAcceptanceExec} from ${imported('scripts/hosted-e2e-transport.mjs')};\nconst trial=JSON.parse(readFileSync(${JSON.stringify(trialPath)},'utf8'));\n${trial.mode==='rehearsal'?`const {installRehearsalModels}=await import(${imported('scripts/hosted-e2e-fixture-model.mjs')});installRehearsalModels(trial.fixture);`:''}\nexport default {...base,activate(host){return base.activate({...host,execFile:wrapAcceptanceExec(host.execFile,{...trial,controlDataDirectory:host.dataDirectory})});}};\n`,{mode:0o600});
 writeFileSync(join(adapter,'package.json'),JSON.stringify({name:'micromanager-hosted-acceptance',version:'0.0.0',type:'module',
  piWeb:{plugins:[{id:'micromanager',module:'browser/entry.js',browserRoot:'browser',serverModule:'server.mjs',machineSpecific:true,defaultEnabled:false}]}}),{mode:0o600});
 make('state/plugins');symlinkSync(adapter,join(state,'plugins','micromanager'));
 writeFileSync(join(agent,'settings.json'),JSON.stringify({defaultProjectTrust:'never',packages:[]}),{mode:0o600});
 const profile=trial.mode==='rehearsal'?{provider:'faux',model:'faux-1'}:{provider:'openai',model:MODEL};
 const configPath=join(root,'pi-web.json');
 writeFileSync(configPath,JSON.stringify({host:'127.0.0.1',port:gatewayPort,spawnSessions:false,subsessions:false,
   plugins:{micromanager:{enabled:true,settings:{productionSecurity:{mode:'production',projectRoots:[project],models:[profile],
    publication:[{repository:trial.repository,baseBranch:trial.base}],
    limits:{maxModelRequests:12,maxToolCalls:50,maxRunMs:180000,maxConcurrentRuns:4},maxCommandMs:30000,
    ...(authFile?{modelAuthFile:authFile}:{})}}}}}),{mode:0o600});
 const env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:root,LANG:'C.UTF-8',
  PI_WEB_CONFIG:configPath,PI_WEB_DATA_DIR:state,PI_CODING_AGENT_DIR:agent,PI_CODING_AGENT_SESSION_DIR:sessions,
  PI_WEB_SESSIOND_SOCKET:socket,PI_WEB_HOST:'127.0.0.1',PI_WEB_PORT:String(gatewayPort),
  PI_WEB_OFFLINE:'1',PI_OFFLINE:'1',PI_WEB_SKIP_VERSION_CHECK:'1',PI_SKIP_VERSION_CHECK:'1',
  ...(ghConfig?{GH_CONFIG_DIR:ghConfig}:{})};
 function launch(name){const c=spawn(process.execPath,[join(serverDir,name)],{cwd:root,env,stdio:['ignore','ignore','ignore']});
  c.failure=null;c.on('error',()=>{c.failure=true;});c.joined=new Promise(resolve=>c.once('close',()=>{c.closed=true;resolve();}));children.push(c);return c;}
 async function stop(c){
  if(!c||c.closed)return;
  remember();const tree=[...descendants(c.pid).values()];
  c.kill('SIGTERM');
  let timeout;await Promise.race([c.joined,new Promise(r=>{timeout=setTimeout(r,15000);})]);clearTimeout(timeout);
  if(!c.closed){c.kill('SIGKILL');signalRecorded(tree,'SIGKILL');await Promise.race([c.joined,sleep(3000)]);fail('shutdown-unproved');}
  signalRecorded(tree,'SIGTERM');await sleep(100);signalRecorded(tree,'SIGKILL');await sleep(100);
  if(tree.some(r=>isStillRunning(r)))fail('shutdown-unproved');
 }
 async function ready(){
  for(let i=0;i<100;i++){
   if(daemon.failure||web.failure||daemon.closed||web.closed)fail('host-startup-failed');
   try{const r=await fetch('http://127.0.0.1:'+gatewayPort,{signal:AbortSignal.timeout(1000)});if(r.ok&&existsSync(socket))return;}catch{}
   await sleep(200);
  }fail('host-startup-timeout');
 }
 async function close(){
  if(closing)return closing;
  closing=(async()=>{
   remember();clearInterval(tracking);const failures=[],tree=[...recorded.values()];
   try{await browser?.close();}catch{failures.push('browser');}
   if(proxy){for(const s of connections)s.destroy();await new Promise(r=>proxy.close(r));}
   for(const c of [...children].reverse())try{await stop(c);}catch{failures.push('child');}
   signalRecorded(tree,'SIGTERM');await sleep(100);signalRecorded(tree,'SIGKILL');await sleep(100);
   if(failures.length||tree.some(r=>isStillRunning(r)))fail('shutdown-unproved');
  })();return closing;
 }
 try{
  daemon=launch('sessiond.js');web=launch('index.js');await ready();
  const password=randomBytes(24).toString('hex'),authorization='Basic '+Buffer.from('acceptance:'+password).toString('base64');
  const permitted=req=>req.headers.authorization===authorization&&req.url?.startsWith('/')&&!req.url.startsWith('//');
  proxy=http.createServer((req,res)=>{
   if(!permitted(req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="local-acceptance"'});res.end();return;}
   const headers={...req.headers};delete headers.authorization;
   const up=http.request({host:'127.0.0.1',port:gatewayPort,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
   up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);
  });
  proxy.on('connection',s=>{connections.add(s);s.on('close',()=>connections.delete(s));});
  proxy.on('upgrade',(req,socket,head)=>{
   if(!permitted(req)){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
   const headers={...req.headers};delete headers.authorization;
   const up=http.request({host:'127.0.0.1',port:gatewayPort,path:req.url,method:'GET',headers});
   up.on('upgrade',(response,target,rest)=>{
    connections.add(target);target.on('close',()=>connections.delete(target));
    socket.write('HTTP/1.1 '+response.statusCode+' Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
    if(rest.length)socket.write(rest);if(head.length)target.write(head);
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.pipe(target).pipe(socket);
   });up.on('error',()=>socket.destroy());up.end();
  });
  await new Promise((r,j)=>proxy.once('error',j).listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+proxy.address().port;
  if((await fetch(origin)).status!==401)fail('ingress-auth-unproved');
  browser=await chromium.launch({headless:true,chromiumSandbox:true,env:{PATH:'/usr/bin:/bin',HOME:home,LANG:'C.UTF-8'}});
  context=await browser.newContext({httpCredentials:{username:'acceptance',password,origin}});
  page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(origin);
  await page.getByRole('button',{name:'Show Actions',exact:true}).click();
  await page.getByTitle('Add Project',{exact:true}).click();
  await page.getByPlaceholder('/path/to/project or ~/code/project').fill(project);
  await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:'Micromanager',exact:true}).first().click();
  await page.waitForFunction(()=>Boolean(window.__mmAcceptance));
  const peer=(op,input)=>page.evaluate(({op,input})=>window.__mmAcceptance.request(op,input),{op,input});
  const readiness=await peer('security.readiness',null);
  if(readiness.mode!=='production'||readiness.workerTools!=='sandbox-only-with-fixed-git-broker')fail('production-mode-unproved');
  async function restart(){
   await stop(daemon);daemon=launch('sessiond.js');await ready();await sleep(1000);
   await page.reload();await page.waitForFunction(()=>Boolean(window.__mmAcceptance));
   await page.getByRole('button',{name:'Reload',exact:true}).click();
   await peer('security.readiness',null);
  }
  return {page,peer,restart,close,origin,pluginState:join(state,'plugin-data/micromanager'),browserVersion:browser.version(),
   identity:()=>page.evaluate(()=>({projectId:window.__mmAcceptance.projectId,workspaceId:window.__mmAcceptance.workspaceId})),
   async importWorkflow(def){
    const box=page.locator('.mm-workflow-import');
    if(!await box.evaluate(e=>e.open))await box.locator('summary').click();
    await page.getByRole('textbox',{name:'Workflow definition JSON'}).fill(JSON.stringify(def));
    await page.getByRole('button',{name:'Validate and save Workflow',exact:true}).click();
    for(let i=0;i<40;i++){try{return await peer('get',def.id);}catch{await sleep(150);}}
    fail('workflow-import-failed');
   }};
 }catch(error){try{await close();}catch{fail('shutdown-unproved');}throw error;}
}
