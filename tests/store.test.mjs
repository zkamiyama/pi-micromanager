import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkflowStore } from '../dist/core/store.js';
import { WorkflowError } from '../dist/core/workflow.js';

const def = () => ({ id: 'example', title: 'Example', maxQcRounds: 2,
  maxParallelByRole: { planner: 1, implementer: 1, reviewer: 1, architect: 1 },
  tasks: [{ id: 'test', title: 'Task', kind: 'implementation', role: 'implementer', dependsOn: [] }] });
function withStore(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mm-'));
  const path = join(dir, 'store.sqlite');
  const store = new WorkflowStore(path);
  try { return callback(store, path); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
const errCode = (fn, code) => assert.throws(fn, e => e instanceof WorkflowError && e.code === code);

test('SQLite writes are scoped by project/workspace', () => withStore(store => {
  store.create('p1','w1',def());
  assert.equal(store.list('p1','w1').length,1);
  assert.equal(store.list('p1','w2').length,0);
  assert.equal(store.list('p2','w1').length,0);
  errCode(() => store.get('p2','w1','example'), 'not_found');
}));

test('revision CAS and command ID idempotency survive restart', () => {
  const dir=mkdtempSync(join(tmpdir(), 'pi-mm-persist-'));
  const path=join(dir,'store.sqlite');
  try {
    let store=new WorkflowStore(path);
    store.create('p','w',def());
    const action = { type:'start',taskId:'test' };
    const a=store.act('p','w','example',0,'cmd-1',action);
    assert.equal(a.revision,1);
    store.close();
    store=new WorkflowStore(path);
    try {
      assert.equal(store.get('p','w','example').tasks.test.status,'running');
      assert.equal(store.act('p','w','example',0,'cmd-1',action).revision,1);
      errCode(()=>store.act('p','w','example',0,'cmd-2',action),'revision_conflict');
      errCode(()=>store.act('p','w','example',0,'cmd-1',{ type:'integrate',taskId:'test' }),'command_conflict');
      assert.equal(store.list('p','w')[0].revision,1);
    } finally { store.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Task-scoped hold survives SQLite restart and command-ID replays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mm-intervention-'));
  const path = join(dir, 'store.sqlite');
  let store;
  try {
    store = new WorkflowStore(path);
    store.create('p', 'w', def());
    const instruction = 'After next QC, pause for Sol to arrange independent diagnosis.';
    const action = { type: 'request_intervention', interventionId: 'pause-next-qc',
      targetTaskId: 'test', afterQcRunId: 'next', instruction };
    const held = store.act('p', 'w', 'example', 0, 'human-request-1', action);
    assert.equal(held.amendments[0].status, 'planning');
    store.close();
    store = new WorkflowStore(path);
    assert.equal(store.get('p', 'w', 'example').amendments[0].instruction, instruction);
    assert.equal(store.act('p', 'w', 'example', 0, 'human-request-1', action).revision, 1);
    errCode(() => store.act('p', 'w', 'example', 0, 'human-request-1',
      { ...action, targetTaskId: 'different' }), 'command_conflict');
    errCode(() => store.act('p', 'w', 'example', 0, 'another-command', action), 'revision_conflict');
    assert.equal(store.get('p', 'w', 'example').amendments.length, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
