/** Thin public-Pi-SDK test adapter. No shell/filesystem/model-selected tools. */
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {Type,InMemoryCredentialStore} from '@earendil-works/pi-ai';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {Harness,createRegistry,defineExtension,defineTool} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {BACKGROUND_CONTEXT,withAbortSignal} from '@earendil-works/chord/context';
import {E2EFailure} from './e2e-contract.mjs';

const requestMethods=new Set(['stream','streamSimple','complete','completeSimple',
  'streamDeferred','fetchDeferred','generateImages','classify']);
const failure=code=>{throw new E2EFailure(code);};

export async function runSdkSmoke(config,{directory,apiKey}){
  const abort=new AbortController(),context=withAbortSignal(abort.signal,BACKGROUND_CONTEXT);
  let first,second,requests=0,reports=0,latched,acceptRequests=true,joined=true;
  const timer=setTimeout(()=>abort.abort(new E2EFailure('timed-out')),config.timeoutMs);
  const stop=()=>abort.abort(new E2EFailure('interrupted'));
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let result={status:'failed',code:'runtime-failed',requests:0,joined:false};
  try{
    let models;
    if(config.mode==='faux'){
      models=createModels();
      const faux=fauxProvider({tokensPerSecond:config.scenario==='slow'?10:100000});
      models.setProvider(faux.provider);
      const call=id=>fauxToolCall('mm_auth_smoke_report',{ok:true},{id});
      const responses=config.scenario==='provider-error'?
        [fauxAssistantMessage('Not successful',{stopReason:'error',errorMessage:'TEST-PRIVATE-PROVIDER-ERROR-MUST-NOT-LEAK'})]:
        config.scenario==='missing-report'?[fauxAssistantMessage('No typed report')]:
        config.scenario==='request-budget'?Array.from({length:5},(_,i)=>
          fauxAssistantMessage([fauxToolCall('unregistered_smoke_tool',{},
            {id:'bounded-unknown-'+i})],{stopReason:'toolUse'})):
        config.scenario==='slow'?[fauxAssistantMessage('Synthetic delayed reply '.repeat(1000))]:
        [fauxAssistantMessage(config.scenario==='duplicate-report'?[call('a'),call('b')]:[call('a')],
          {stopReason:'toolUse'}),fauxAssistantMessage('Completed.')];
      faux.setResponses(responses);
    }else{
      // Public in-memory CredentialStore; no daemon HOME, auth.json, models.json,
      // environment credential fallback or network catalogue refresh.
      const credentials=new InMemoryCredentialStore();
      await credentials.modify(config.provider,async()=>({type:'api_key',key:apiKey}));
      models=await ModelRuntime.create({credentials,modelsPath:null,
        allowModelNetwork:false,refreshOnCreate:false,signal:abort.signal});
    }
    abort.signal.throwIfAborted();
    if(!models.getModel(config.provider,config.model))failure('model-unavailable');
    const bounded=new Proxy(models,{get(target,property){
      const value=Reflect.get(target,property,target);
      if(typeof value!=='function')return value;
      return (...args)=>{
        if(requestMethods.has(property)){
          abort.signal.throwIfAborted();
          if(!acceptRequests){latched='replay-detected';failure(latched);}
          if(requests>=4){latched='request-budget';failure(latched);}
          if(args[0]?.provider!==config.provider||args[0]?.id!==config.model){
            latched='model-unavailable';failure(latched);
          }
          requests++;
          const previous=args[2]??{};
          args[2]={...previous,maxTokens:256,signal:previous.signal?
            AbortSignal.any([abort.signal,previous.signal]):abort.signal};
        }
        return Reflect.apply(value,target,args);
      };
    }});
    const report=defineTool({name:'mm_auth_smoke_report',
      description:'Record a synthetic test-only boolean acknowledgment exactly once.',
      parameters:Type.Object({ok:Type.Literal(true)}),replay:'safe',
      async execute(){
        abort.signal.throwIfAborted();
        if(++reports!==1){latched='duplicate-report';failure(latched);}
        return {output:[{type:'text',text:'Synthetic test receipt stored.'}]};
      }});
    const registry=createRegistry();
    registry.install(defineExtension({name:'mm-e2e-smoke',tools:[report]}));
    const settings={models:bounded,registry,settings:{toolExecution:'sequential',
      compaction:{enabled:false},stream:{maxRetries:0,timeoutMs:config.timeoutMs},retry:{maxRetries:0}}};
    const agent={model:{provider:config.provider,modelId:config.model},cwd:directory,
      tools:[report],modelTools:[report],
      instructions:'Call mm_auth_smoke_report once with ok=true, then finish. No other action.'};
    const database=join(directory,'smoke.sqlite'),requestId='mm-e2e-single-input';
    first=await Harness.open(await openNodeSqliteStorage(database),settings,context);
    const root=await first.root(context,{agent});
    const sent=await root.submit({type:'input',content:'Acknowledge this synthetic test using the report tool once.',requestId},context);
    const settled=await sent.wait(context);
    await root.waitForIdle(context);
    abort.signal.throwIfAborted();
    if(latched)failure(latched);
    if(settled.status!=='done')failure('input-not-completed');
    if(reports!==1)failure(reports>1?'duplicate-report':'missing-report');
    const proof=await first.commit(tx=>tx.submissionByRequest(root.id,requestId),context);
    if(proof?.type!=='input'||proof.status!=='done')failure('input-not-completed');
    const originalId=root.id,before=requests;
    acceptRequests=false;
    await first.close(BACKGROUND_CONTEXT);first=undefined;
    second=await Harness.open(await openNodeSqliteStorage(database),settings,context);
    const reopened=await second.root(context,{agent});
    const persisted=await second.commit(tx=>tx.submissionByRequest(reopened.id,requestId),context);
    const inspection=await second.inspect(context);
    if(reopened.id!==originalId||persisted?.type!=='input'||persisted.status!=='done'||
      inspection.tasks.length||inspection.submissions.length||requests!==before||reports!==1||latched)
      failure('replay-detected');
    result={status:'passed',code:'ok',requests,joined:false};
  }catch(error){
    const safe=abort.signal.aborted?abort.signal.reason:error;
    result={status:'failed',code:safe instanceof E2EFailure?safe.code:'runtime-failed',requests,joined:false};
  }finally{
    acceptRequests=false;abort.abort(new E2EFailure('interrupted'));
    const closes=await Promise.allSettled([first,second].filter(Boolean).map(h=>h.close(BACKGROUND_CONTEXT)));
    joined=closes.every(x=>x.status==='fulfilled');
    clearTimeout(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
    if(!joined)result={status:'failed',code:'shutdown-unproved',requests,joined:false};
    else result.joined=true;
  }
  return result;
}
