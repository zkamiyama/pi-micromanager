import test from 'node:test';
import assert from 'node:assert/strict';
import {withModelBudget} from '../dist/security/model-boundary.js';

test('Model budget checks every request entrypoint before delegating and permits cancellation',()=>{
 const methods=['stream','streamSimple','complete','completeSimple','streamDeferred','fetchDeferred','generateImages','classify'];
 let delegated=0,admissions=0,cancelled=0,allowed=true;
 const model=Object.fromEntries(methods.map(name=>[name,()=>{delegated++;return name;}]));
 model.cancelDeferred=()=>{cancelled++;};
 const bounded=withModelBudget(model,()=>{admissions++;if(!allowed)throw Error('budget exhausted');});
 for(const name of methods)assert.equal(bounded[name](),name);
 assert.equal(delegated,methods.length);
 allowed=false;
 for(const name of methods)assert.throws(()=>bounded[name](),/budget exhausted/);
 bounded.cancelDeferred();
 assert.equal(delegated,methods.length);assert.equal(admissions,methods.length*2);assert.equal(cancelled,1);
});

test('Model wrapper preserves private-field SDK receivers without charging local metadata reads',()=>{
 class SDK {
  #value=7;
  getModel(){return this.#value;}
  streamSimple(){return this.#value;}
 }
 let requests=0;
 const bounded=withModelBudget(new SDK(),()=>requests++);
 assert.equal(bounded.getModel(),7);assert.equal(requests,0);
 assert.equal(bounded.streamSimple(),7);assert.equal(requests,1);
});

test('ADR19 diagnostic output cap preserves smaller requests and cancellation without mutating caller options',()=>{
 let received,admitted=0;
 const runtime={streamSimple(...a){received=a;return 'stream';},cancelDeferred(){return 'cancelled';},generateImages(){throw Error('must not delegate');}};
 const models=withModelBudget(runtime,()=>admitted++,512);
 const signal=new AbortController().signal,opts={maxTokens:99999,signal};
 assert.equal(models.streamSimple({}, {},opts),'stream');assert.equal(received[2].maxTokens,512);
 assert.equal(received[2].signal,signal);assert.equal(opts.maxTokens,99999);
 models.streamSimple({}, {},{maxTokens:128});assert.equal(received[2].maxTokens,128);
 assert.equal(models.cancelDeferred(),'cancelled');assert.equal(admitted,2);
 assert.throws(()=>models.generateImages(),/not bounded/);
 assert.throws(()=>withModelBudget(runtime,()=>{},Infinity),/output bound/);
});
