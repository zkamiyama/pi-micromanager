import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

test("Read-only doctor explains usage without GitHub credentials",()=>{
 const out=spawnSync(process.execPath,["scripts/doctor.mjs","--help"],{encoding:"utf8"});
 assert.equal(out.status,0,out.stderr);
 assert.match(out.stdout,/--target/);
});
test("Doctor refuses unexpected command arguments without side effects",()=>{
 const out=spawnSync(process.execPath,["scripts/doctor.mjs","--delete-worktrees"],{encoding:"utf8"});
 assert.equal(out.status,2);
 assert.match(out.stderr,/Invalid arguments/);
});
