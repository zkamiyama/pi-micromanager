import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {resolveManagedGitWorkspace} from "../dist/automation/workspace-discovery.js";

const projectId="project-123",path="/tmp/pi-micromanager/owned-worktree";
const candidate=createHash("sha1").update(projectId+":"+resolve(path))
  .digest("hex").slice(0,12);
const authority={
  project:{id:projectId,name:"test",path:"/repo"},
  workspace:{id:candidate,projectId,path:resolve(path),label:"branch",
    isMain:false,provider:{metadata:{isGitWorktree:true}}},
};

test("PI WEB Git Workspace ID is derived but never trusted without host resolve",async()=>{
 let verified=0;
 const api={version:1,async resolve(request){
   verified++;
   assert.deepEqual(request,{projectId,workspaceId:candidate});
   return authority;
 }};
 assert.equal(await resolveManagedGitWorkspace(api,projectId,path),candidate);
 assert.equal(verified,1);
});

test("Provider mismatch, stale path and non-linked worktrees are rejected",async()=>{
 for(const workspace of [
   {...authority.workspace,path:"/somewhere/else"},
   {...authority.workspace,isMain:true},
   {...authority.workspace,provider:{metadata:{isGitWorktree:false}}},
   {...authority.workspace,id:"different"},
 ]){
   const api={version:1,async resolve(){return {...authority,workspace};}};
   await assert.rejects(resolveManagedGitWorkspace(api,projectId,path),/does not match/);
 }
 await assert.rejects(resolveManagedGitWorkspace(
   {version:1,async resolve(){throw Error("not found");}},projectId,path),/did not discover/);
 await assert.rejects(resolveManagedGitWorkspace(
   {version:1,async resolve(){return authority;}},projectId,"relative/path"),/absolute/);
});
