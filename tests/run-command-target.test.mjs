import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLiveCommandTarget} from '../dist/pi-web/fleet.js';
const target={projectId:'p',orchestraWorkspaceId:'o',workflowId:'wf',taskId:'a',workspaceId:'w',
 runId:'qc-a-1',sessionId:'durable:qc',seat:'qc',connected:true,phase:'running'};
test('ADR19 UI resolves only the exact active QC, never a nearby role or another scope',()=>{
 const latest={...target,latestText:'new activity'};
 assert.equal(resolveLiveCommandTarget([latest],target,true),latest);
 assert.equal(resolveLiveCommandTarget([latest],target,false),undefined);
 for(const key of ['projectId','orchestraWorkspaceId','workflowId','taskId','workspaceId','runId','sessionId','seat'])
  assert.equal(resolveLiveCommandTarget([{...latest,[key]:'other'}],target,true),undefined,key);
});
test('ADR19 UI refuses ended/disconnected/ambiguous targets and never dispatches from history',()=>{
 for(const phase of ['settled','sealed','failed','uncertain','blocked','reserved','created','connected'])
  assert.equal(resolveLiveCommandTarget([{...target,phase}],target,true),undefined,phase);
 assert.equal(resolveLiveCommandTarget([{...target,connected:false}],target,true),undefined);
 assert.equal(resolveLiveCommandTarget([target,target],target,true),undefined);
 assert.equal(resolveLiveCommandTarget([],target,true),undefined);
 assert.equal(resolveLiveCommandTarget([target],{...target,sessionId:null},true),undefined);
});
test('ADR19 UI configured state is a start target only, while function preserves actual phase',()=>{
 const current={...target,phase:'configured'};
 assert.equal(resolveLiveCommandTarget([current],target,true).phase,'configured');
});
