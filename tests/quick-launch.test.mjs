import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {QuickLaunchLedger,parseQuickProfile} from "../dist/automation/quick-launch.js";

const id1="c66c2bb2-91ba-43bf-9e58-047197b147aa";
const id2="ab5f0177-78c5-41d4-9b56-1e3d7c746511";
const profile={config:{
  managedWorktrees:true,workspaces:{},
  finalization:{workspaceId:"auto",autoMerge:true},
  publication:{remote:"origin",baseBranch:"main",draft:true},
  models:Object.fromEntries(["planner","implementer","qc","architect"]
    .map(role=>[role,{provider:"example",model:"exact-model"}])),
  test:{execution:"trusted-host",file:"node",args:["--test"],timeoutMs:60000},maxAttempts:3,
},permissions:{default:"allow",
  actions:{"github.pr.merge":"ask","deploy.production":"deny"}}};

test("Quick launch requires an explicit reviewed project setup and unique request",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-quick-")),file=join(dir,"quick.sqlite");
 let ledger=new QuickLaunchLedger(file);
 try{
   assert.throws(()=>ledger.begin("p","o","A goal",id1),/Save a one-command/);
   assert.throws(()=>parseQuickProfile({...profile,config:{...profile.config,
     managedWorktrees:false}}),/managedWorktrees/);
   assert.throws(()=>parseQuickProfile({...profile,config:{...profile.config,
     workspaces:{api:"reused"}}}),/empty workspaces/);
   assert.throws(()=>parseQuickProfile({...profile,config:{...profile.config,
     finalization:{workspaceId:"prelinked",autoMerge:true}}}),/finalization:auto/);
   assert.throws(()=>parseQuickProfile({...profile,permissions:{
     actions:{"untrusted.action":"allow"}}}),/Unknown permission/);
   assert.throws(()=>parseQuickProfile({...profile,permissions:undefined}),/explicit/);
   const saved=ledger.saveProfile("p","o",profile);
   assert.equal(saved.permissions.actions["github.pr.merge"],"ask");
   assert.equal(ledger.profile("p","another"),null);
   const first=ledger.begin("p","o","Build a safe feature",id1);
   assert.match(first.workflowId,/^quick-[0-9a-f]{16}$/);
   assert.equal(first.phase,"reserved");
   assert.equal(ledger.begin("p","o","Build a safe feature",id1).workflowId,first.workflowId);
   assert.throws(()=>ledger.begin("p","o","Different goal",id1),/different goal/);
   assert.throws(()=>ledger.begin("p","o","New feature",id2),/already active/);
   ledger.saveProfile("p","o",{...profile,permissions:{
     default:"deny",actions:{"github.pr.merge":"deny"}}});
   assert.equal(ledger.find("p","o",id1).profile.permissions.actions["github.pr.merge"],"ask",
     "The profile is frozen for the exact accepted request");
   assert.equal(ledger.cancel("p","o",id1).phase,"cancelled");
   assert.throws(()=>ledger.phase("p","o",id1,"planning","should not"),/cannot restart/);
   assert.equal(ledger.begin("p","o","Next feature",id2).phase,"reserved");
   ledger.close();
   ledger=new QuickLaunchLedger(file);
   assert.equal(ledger.find("p","o",id2).phase,"reserved");
   assert.equal(ledger.list("p","o").length,2);
   assert.equal(ledger.pending().length,1);
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test("Request IDs and stage transitions cannot silently widen permissions or restart terminal requests",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-quick-")),ledger=new QuickLaunchLedger(join(dir,"quick.sqlite"));
 try{
   ledger.saveProfile("p","o",profile);
   assert.throws(()=>ledger.begin("p","o","some goal","not-a-uuid"),/unique requestId/);
   assert.throws(()=>ledger.begin("p","o","\0 bad",id1),/development goal/);
   ledger.begin("p","o","Build",id1);
   ledger.phase("p","o",id1,"planning","Sol started");
   ledger.phase("p","o",id1,"starting","Starting the DAG");
   ledger.phase("p","o",id1,"running","Real Pi Sessions admitted");
   assert.throws(()=>ledger.cancel("p","o",id1),/code run has begun/);
   ledger.phase("p","o",id1,"finished","GitHub MERGED");
   assert.throws(()=>ledger.phase("p","o",id1,"starting","Again"),/cannot restart/);
   assert.equal(ledger.begin("p","o","Another",id2).phase,"reserved");
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

test("Copyable one-command trial setup uses safe reviewed defaults",()=>{
 const path=resolve("examples/trial.one-command.json");
 const template=JSON.parse(readFileSync(path,"utf8"));
 const parsed=parseQuickProfile(template);
 assert.equal(parsed.config.managedWorktrees,true);
 assert.equal(parsed.config.finalization.workspaceId,"auto");
 assert.equal(parsed.config.finalization.autoMerge,true);
 assert.equal(parsed.permissions.actions["github.pr.merge"],"ask");
 assert.equal(parsed.permissions.actions["deploy.production"],"deny");
});

test("Previously saved one-command profiles and pending requests stay native after Durable becomes the default",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-quick-legacy-")),file=join(dir,"quick.sqlite");
 let ledger=new QuickLaunchLedger(file);
 try{
   assert.equal(parseQuickProfile(profile).config.runtime,"durable",
     "New profiles default to Durable");
   ledger.saveProfile("p","o",profile);
   ledger.begin("p","o","Existing goal",id1);
   ledger.close();
   // Model a profile and queued request from before the runtime field existed.
   const db=new DatabaseSync(file);
   const legacy=JSON.stringify(profile),scope=JSON.stringify(["p","o"]);
   db.prepare("UPDATE quick_profiles SET profile_json=? WHERE scope=?")
     .run(legacy,scope);
   db.prepare("UPDATE quick_goals SET profile_json=? WHERE scope=? AND request_id=?")
     .run(legacy,scope,id1);
   db.close();
   ledger=new QuickLaunchLedger(file);
   assert.equal(ledger.profile("p","o").config.runtime,"pi-web");
   assert.equal(ledger.find("p","o",id1).profile.config.runtime,"pi-web");
   assert.equal(ledger.pending()[0].profile.config.runtime,"pi-web");
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
