/** Narrow process boundary for untrusted repository tools. No host fallback. */
import {spawn} from "node:child_process";
import {lstatSync,realpathSync,opendirSync,mkdtempSync,rmSync,existsSync} from "node:fs";
import {join,resolve,relative,isAbsolute,sep} from "node:path";
import {tmpdir} from "node:os";
export interface SandboxLimits {maxCommandMs:number;maxWorkspaceBytes:number}
export interface ProcessResult {exitCode:number;stdout:string;stderr:string;truncated:boolean}
export function inspectSandboxWorkspace(root:string,maxBytes:number):void{
  if(realpathSync(root)!==resolve(root)||!lstatSync(root).isDirectory())throw new Error("Sandbox Workspace must be a canonical directory");
  let files=0,bytes=0;const pending=[root];
  while(pending.length){
    const folder=pending.pop()!;
    const directory=opendirSync(folder);
    try{let entry;
    while((entry=directory.readSync())!==null){
      if(folder===root&&entry.name===".git")continue;
      const path=join(folder,entry.name),stat=lstatSync(path);
      if(++files>50000)throw new Error("Sandbox Workspace file budget exceeded");
      if(stat.isSymbolicLink()){
        const rel=relative(root,realpathSync(path));
        if(isAbsolute(rel)||rel===".."||rel.startsWith(".."+sep))throw new Error("Sandbox Workspace contains an external symlink");
        continue;
      }
      if((!stat.isFile()&&!stat.isDirectory())||stat.isFile()&&stat.nlink!==1)
        throw new Error("Sandbox Workspace contains a hardlink, socket, device or special file");
      if(stat.isDirectory())pending.push(path);else bytes+=stat.size;
      if(bytes>maxBytes)throw new Error("Sandbox Workspace byte budget exceeded");
    }}finally{directory.closeSync();}
  }
}
export function sandboxInvocation(root:string,argv:readonly string[],readonly:boolean,
  emptyGitDirectory:string,limits:SandboxLimits):{file:string;args:string[]}{
  if(process.platform!=="linux")throw new Error("Production tools require Linux Bubblewrap");
  if(!argv.length||argv.some(x=>typeof x!=="string"||x.includes("\0"))||argv.join("").length>2*1024*1024)
    throw new Error("Invalid bounded sandbox argv");
  const git=join(root,".git"),mask:string[]=existsSync(git)?
    ["--ro-bind",lstatSync(git).isDirectory()?emptyGitDirectory:"/dev/null","/workspace/.git"]:[];
  return {file:"/usr/bin/bwrap",args:[
    "--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL",
    "--ro-bind","/usr","/usr","--ro-bind","/bin","/bin",
    "--ro-bind-try","/lib","/lib","--ro-bind-try","/lib64","/lib64",
    "--ro-bind-try","/etc/ld.so.cache","/etc/ld.so.cache",
    "--dir","/runtime","--ro-bind",realpathSync(process.execPath),"/runtime/node",
    "--proc","/proc","--dev","/dev","--tmpfs","/tmp",
    readonly?"--ro-bind":"--bind",root,"/workspace",...mask,"--chdir","/workspace",
    "--clearenv","--setenv","PATH","/runtime:/usr/bin:/bin","--setenv","HOME","/tmp",
    "--setenv","LANG","C.UTF-8","--",
    "/usr/bin/prlimit","--cpu="+Math.ceil(limits.maxCommandMs/1000+5),"--nofile=256","--fsize=67108864","--",
    ...argv,
  ]};
}
export async function boundedProcess(file:string,args:readonly string[],options:{
  cwd:string;timeoutMs:number;signal?:AbortSignal;env?:NodeJS.ProcessEnv;input?:string;
}):Promise<ProcessResult>{
  options.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(file,[...args],{cwd:options.cwd,env:options.env??{PATH:"/usr/bin:/bin"},
      detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="",bytes=0,truncated=false,interrupted=false;
    const kill=()=>{
      interrupted=true;
      try{if(child.pid&&process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}
    };
    const timer=setTimeout(kill,options.timeoutMs);timer.unref();
    options.signal?.addEventListener("abort",kill,{once:true});
    child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>128*1024){truncated=true;kill();return;}stdout+=chunk.toString("utf8");});
    child.stderr.on("data",chunk=>{bytes+=chunk.length;if(bytes>128*1024){truncated=true;kill();return;}stderr+=chunk.toString("utf8");});
    const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener("abort",kill);};
    child.once("error",error=>{cleanup();reject(error);});
    child.once("close",code=>{cleanup();
      if(interrupted&&!truncated)reject(new Error("Sandbox command interrupted or timed out; process group terminated"));
      else resolve({exitCode:code??1,stdout,stderr,truncated});});
    child.stdin.on("error",()=>{});child.stdin.end(options.input??"");
  });
}
export async function sandboxExec(root:string,argv:readonly string[],readonly:boolean,
  limits:SandboxLimits,signal?:AbortSignal,input?:string):Promise<ProcessResult>{
  inspectSandboxWorkspace(root,limits.maxWorkspaceBytes);
  const empty=mkdtempSync(join(tmpdir(),"mm-git-mask-"));
  try{
    const invocation=sandboxInvocation(root,argv,readonly,empty,limits);
    const result=await boundedProcess(invocation.file,invocation.args,{cwd:root,timeoutMs:limits.maxCommandMs,
      ...(signal?{signal}:{}),...(input===undefined?{}:{input})});
    if(result.exitCode!==0&&/^bwrap:/m.test(result.stderr))throw new Error("Production sandbox refused to start; no host fallback: "+result.stderr.slice(0,250));
    if(result.truncated)throw new Error("Sandbox output budget exceeded");
    return result;
  }finally{rmSync(empty,{recursive:true,force:true});}
}
/** All path resolution happens INSIDE the mount boundary. JSON is never code. */
export const FILE_SERVICE=String.raw`
const fs=require('node:fs'),p=require('node:path');
const data=fs.readFileSync(0,'utf8');if(data.length>1100000)throw Error('Input too large');
const q=JSON.parse(data);let name=q.path||'.';
if(typeof name!=='string'||name.includes('\0')||p.isAbsolute(name))throw Error('Relative path required');
const parts=name.split(/[\\/]+/);if(parts.some(x=>x==='..'||x==='.git'))throw Error('Forbidden path');
const file=p.resolve('/workspace',name);if(file!=='/workspace'&&!file.startsWith('/workspace/'))throw Error('Path escaped');
let parent='/workspace';for(const part of parts.filter(x=>x&&x!=='.')){
 parent=p.join(parent,part);if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('Symlink refused');
}
const out=x=>process.stdout.write(JSON.stringify(x));
if(q.op==='read'){
 const s=fs.lstatSync(file);if(!s.isFile()||s.size>1048576)throw Error('Bounded regular text file required');
 const b=fs.readFileSync(file);if(b.includes(0))throw Error('Binary file not supported');
 const lines=b.toString('utf8').split(/\r?\n/),from=Math.max(0,(q.offset||1)-1),limit=Math.min(500,q.limit||200);
 const text=lines.slice(from,from+limit).join('\n');if(Buffer.byteLength(text)>60000)throw Error('Narrow the requested text range');
 out({text,totalLines:lines.length,firstLine:from+1,truncated:from+limit<lines.length});
}else if(q.op==='list'){
 const names=fs.readdirSync(file,{withFileTypes:true}).filter(e=>e.name!=='.git').sort((a,b)=>a.name.localeCompare(b.name));
 out({entries:names.slice(0,200).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isFile()?'file':'other'})),truncated:names.length>200});
}else if(q.op==='write'||q.op==='edit'){
 if(typeof q.content!=='string'||Buffer.byteLength(q.content)>1048576)throw Error('Bounded content required');
 let content=q.content;
 if(q.op==='edit'){
  if(typeof q.oldText!=='string'||!q.oldText)throw Error('Exact oldText required');
  const old=fs.readFileSync(file,'utf8');if(old.length>1048576)throw Error('File too large');
  if(old.split(q.oldText).length!==2)throw Error('Exactly one matching edit required');content=old.replace(q.oldText,q.content);
 }
 fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,content,{flag:'w'});out({written:Buffer.byteLength(content)});
}else throw Error('Unsupported file operation');
`;
