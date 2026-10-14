/** Host-owned settings: never accept a Workflow's assertion of isolation. */
import {realpathSync} from "node:fs";
import {validateModelAuthFile} from "./auth-source.js";
import {isAbsolute,relative,resolve,sep} from "node:path";
import {DEFAULT_LIMITS,validateRunLimits,type RunLimits} from "./run-safety.js";
import {parseStorageLimits,type StorageLimits} from "./storage-admission.js";
import {parseTestDiagnosticPolicy,type TestDiagnosticPolicy} from "../automation/private-test-diagnostics.js";
export interface ProductionPolicy {
  mode:"production";projectRoots:string[];models:Array<{provider:string;model:string}>;
  publication:Array<{repository:string;baseBranch:string}>;limits:RunLimits;
  maxCommandMs:number;maxWorkspaceBytes:number;storage:StorageLimits;diagnostics:TestDiagnosticPolicy;
  modelAuthFile?:string;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function text(v:unknown,max:number):string{
  if(typeof v!=="string"||!v.trim()||v.length>max||v.includes("\0"))throw new Error("Invalid production policy text");
  return v;
}
function bound(v:unknown,d:number,min:number,max:number):number{
  const n=v??d;if(typeof n!=="number"||!Number.isSafeInteger(n)||n<min||n>max)throw new Error("Invalid production bound");return n;
}
export function isWithin(root:string,path:string):boolean{
  const rel=relative(root,path);return !rel||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel);
}
export function parseProductionPolicy(value:unknown):ProductionPolicy|undefined{
  if(value===undefined)return;
  if(!object(value)||value.mode!=="production")throw new Error("Explicit host production policy required");
  if(Object.keys(value).some(k=>!["mode","projectRoots","models","publication","limits","maxCommandMs","maxWorkspaceBytes","storage","diagnostics","modelAuthFile"].includes(k)))
    throw new Error("Unknown production policy field");
  if(!Array.isArray(value.projectRoots)||!value.projectRoots.length||value.projectRoots.length>32)
    throw new Error("Production requires 1..32 explicit project roots");
  const projectRoots=value.projectRoots.map(p=>{
    const s=text(p,1024);if(!isAbsolute(s)||resolve(s)===sep)throw new Error("Filesystem root cannot be a project allowlist");return realpathSync(s);
  });
  if(new Set(projectRoots).size!==projectRoots.length)throw new Error("Duplicate project root");
  if(!Array.isArray(value.models)||!value.models.length||value.models.length>32)throw new Error("Explicit model allowlist required");
  const models=value.models.map(m=>{
    if(!object(m)||Object.keys(m).some(k=>k!=="provider"&&k!=="model"))throw new Error("Invalid model allowlist entry");
    return {provider:text(m.provider,120),model:text(m.model,160)};
  });
  const destinations=value.publication??[];
  if(!Array.isArray(destinations)||destinations.length>32)throw new Error("Invalid publication allowlist");
  const publication=destinations.map(d=>{
    if(!object(d)||Object.keys(d).some(k=>k!=="repository"&&k!=="baseBranch"))throw new Error("Invalid publication entry");
    const repository=text(d.repository,200).toLowerCase(),baseBranch=text(d.baseBranch,120);
    if(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)||repository.split("/").some(p=>p==="."||p==="..")||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(baseBranch)||baseBranch.includes("..")||baseBranch.includes("//")||
      baseBranch.endsWith("/")||baseBranch.endsWith(".")||baseBranch.endsWith(".lock"))throw new Error("Unsafe publication destination");
    return {repository,baseBranch};
  });
  if(value.limits!==undefined&&(!object(value.limits)||Object.keys(value.limits).some(k=>!Object.hasOwn(DEFAULT_LIMITS,k))))
    throw new Error("Unknown production budget field");
  const limits=validateRunLimits({...DEFAULT_LIMITS,maxConcurrentRuns:4,...(value.limits as Partial<RunLimits>??{})});
  const modelAuthFile=value.modelAuthFile===undefined?undefined:
    validateModelAuthFile(value.modelAuthFile,projectRoots);
  return {mode:"production",projectRoots,models,publication,limits,storage:parseStorageLimits(value.storage),diagnostics:parseTestDiagnosticPolicy(value.diagnostics),
    ...(modelAuthFile?{modelAuthFile}:{}),
    maxCommandMs:bound(value.maxCommandMs,60_000,1000,120_000),
    maxWorkspaceBytes:bound(value.maxWorkspaceBytes,512*1024*1024,1024*1024,4*1024*1024*1024)};
}
export function assertProductionModel(policy:ProductionPolicy,model:{provider:string;model:string}):void{
  if(!policy.models.some(m=>m.provider===model.provider&&m.model===model.model))throw new Error("Model outside host production allowlist");
}
export function assertProductionProject(policy:ProductionPolicy,path:string):void{
  if(!policy.projectRoots.includes(realpathSync(path)))throw new Error("Project outside host production allowlist");
}
export function assertProductionDestination(policy:ProductionPolicy,repository:string,base:string):void{
  if(!policy.publication.some(d=>d.repository===repository.toLowerCase()&&d.baseBranch===base))
    throw new Error("Publication repository/base outside host production allowlist");
}
export function assertProductionConfig(policy:ProductionPolicy,config:unknown,definition:unknown):void{
  if(!object(config)||config.runtime!=="durable")throw new Error("Production requires the isolated Durable runtime");
  if(!object(config.test)||config.test.execution!=="sandbox")throw new Error("Production forbids trusted-host verification");
  if(!object(config.models))throw new Error("Production model profiles required");
  for(const raw of Object.values(config.models)){
    if(!object(raw))throw new Error("Invalid model profile");
    assertProductionModel(policy,{provider:text(raw.provider,120),model:text(raw.model,160)});
  }
  if(!object(definition))throw new Error("Production Workflow required");
  const p=definition.permissions;
  if(!object(p))throw new Error("Production requires explicit external mutation permissions");
  for(const action of ["git.push","github.pr.create","github.pr.merge"]){
    const decision=object(p.actions)?p.actions[action]??p.default:p.default;
    if(decision!=="ask"&&decision!=="deny")throw new Error("Production requires human approval or deny: "+action);
  }
}
const contexts=new Map<string,ProductionPolicy>();
export function installProductionPolicy(dataRoot:string,policy:ProductionPolicy):()=>void{
  const root=realpathSync(dataRoot);
  if(contexts.has(root))throw new Error("Production data root already registered");
  const frozen=structuredClone(policy);
  Object.freeze(frozen.limits);Object.freeze(frozen.storage);Object.freeze(frozen.diagnostics.labels);Object.freeze(frozen.diagnostics);
  frozen.models.forEach(Object.freeze);frozen.publication.forEach(Object.freeze);
  Object.freeze(frozen.projectRoots);Object.freeze(frozen.models);Object.freeze(frozen.publication);
  Object.freeze(frozen);contexts.set(root,frozen);
  return ()=>{if(contexts.get(root)===frozen)contexts.delete(root);};
}
export function productionPolicy(dataRoot:string):ProductionPolicy|undefined{return contexts.get(realpathSync(dataRoot));}
