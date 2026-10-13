/** Bounded, shell-free repository navigation for read-only Durable roles.
 * Deliberately excludes symlinks and non-source folders; it is not an OS sandbox. */
import {readdir,lstat,open,realpath} from "node:fs/promises";
import {join,relative,sep,resolve} from "node:path";
import {constants} from "node:fs";
import {Type} from "@earendil-works/pi-ai";
import {defineTool} from "@earendil-works/pi-durable";
const SKIP=new Set([".git","node_modules",".next",".cache","coverage","dist","build",".venv","vendor"]);
const MAX_FILES=1200,MAX_RESULTS=60,MAX_SCANNED_BYTES=3*1024*1024;
const MAX_SINGLE_FILE=128*1024;
function prefix(value:string|undefined):string{
  if(!value)return "";
  const parts=value.replaceAll("\\","/").split("/").filter(Boolean);
  if(parts.some(p=>p==="."||p===".."||p.startsWith(".")||!(/^[a-zA-Z0-9._-]+$/.test(p))))
    throw new Error("Invalid bounded search path prefix");
  return parts.join("/");
}
async function files(root:string):Promise<string[]>{
  const canonical=await realpath(root);
  if(canonical!==resolve(root))throw new Error("Workspace path changed");
  const found:string[]=[],pending=[""];
  while(pending.length&&found.length<MAX_FILES){
    const folder=pending.shift()!;
    let children;
    try{children=await readdir(join(root,folder),{withFileTypes:true});}
    catch{continue;}
    for(const entry of children.sort((a,b)=>a.name.localeCompare(b.name))){
      if(found.length>=MAX_FILES)break;
      if(entry.isSymbolicLink()||entry.name.startsWith(".")||entry.name==="..")continue;
      const rel=folder?folder+"/"+entry.name:entry.name;
      if(entry.isDirectory()){
        if(!SKIP.has(entry.name)&&pending.length<MAX_FILES)pending.push(rel);
      }else if(entry.isFile()){
        if(rel.length<=240)found.push(rel);
      }
    }
  }
  return found.sort();
}
async function safeText(root:string,rel:string):Promise<string|undefined>{
  const path=join(root,...rel.split("/"));
  const stat=await lstat(path).catch(()=>undefined);
  if(!stat?.isFile()||stat.size>MAX_SINGLE_FILE)return;
  const fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const inside=relative(await realpath(root),await realpath(path));
    if(inside.startsWith(".."+sep)||inside===".."||inside.startsWith(sep))
      throw new Error("Search path escaped trusted Workspace");
    const actual=await fd.stat();
    if(!actual.isFile()||actual.size>MAX_SINGLE_FILE||
      actual.ino!==stat.ino||actual.dev!==stat.dev)return;
    const blob=await fd.readFile();
    if(blob.includes(0))return;
    return blob.toString("utf8");
  }finally{await fd.close();}
}
function message(value:unknown){return {output:[{type:"text" as const,text:JSON.stringify(value)}]};}
/** Register these tools for QC, investigations and planning; never write or execute. */
export function readonlyDiscoveryTools(cwd:string){
  const list=defineTool({name:"mm_list_repo_files",
    description:"List bounded source filenames under the current repository. Read-only and shell-free.",
    replay:"safe",parameters:Type.Object({pathPrefix:Type.Optional(Type.String({maxLength:160}))}),
    async execute(args){
      const p=prefix(args.pathPrefix),all=await files(cwd);
      const selected=all.filter(x=>!p||x===p||x.startsWith(p+"/"));
      return message({files:selected.slice(0,120),totalCapped:selected.length,
        truncated:selected.length>120||all.length>=MAX_FILES});
    }});
  const search=defineTool({name:"mm_search_repo_text",
    description:"Search source text for a literal word or phrase. Read-only, no shell, bounded output.",
    replay:"safe",parameters:Type.Object({
      text:Type.String({minLength:2,maxLength:120}),
      pathPrefix:Type.Optional(Type.String({maxLength:160})),
    }),
    async execute(args){
      const p=prefix(args.pathPrefix),all=(await files(cwd)).filter(x=>
        (!p||x===p||x.startsWith(p+"/")));
      let consumed=0;const hits:Array<{path:string;line:number;text:string}>=[];
      for(const file of all){
        if(hits.length>=MAX_RESULTS||consumed>=MAX_SCANNED_BYTES)break;
        const data=await safeText(cwd,file).catch(()=>undefined);
        if(data===undefined)continue;
        consumed+=Buffer.byteLength(data);
        if(consumed>MAX_SCANNED_BYTES)break;
        const lines=data.split(/\r?\n/);
        for(let i=0;i<lines.length&&hits.length<MAX_RESULTS;i++){
          if(lines[i]!.includes(args.text)){
            // Return matching source context, never tool commands or entire files.
            hits.push({path:file,line:i+1,text:lines[i]!.slice(0,180)});
          }
        }
      }
      return message({matches:hits,truncated:hits.length>=MAX_RESULTS||
        consumed>=MAX_SCANNED_BYTES||all.length>=MAX_FILES});
    }});
  return [list,search];
}
