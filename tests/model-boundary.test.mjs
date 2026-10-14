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
