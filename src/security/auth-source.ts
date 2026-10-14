/** Host-selected credential location. Inspect metadata only; the public Pi SDK
 * owns credential reads and serialized refresh. Never copy credentials into a
 * Workspace or derive this authority from a Workflow/model argument. */
import {lstatSync,realpathSync} from "node:fs";
import {dirname,isAbsolute,relative,resolve,sep} from "node:path";

export function validateModelAuthFile(value:unknown,excludedRoots:readonly string[]):string{
  const denied=()=>{throw new Error("Unsafe host model credential source");};
  if(typeof value!=="string"||value.length>1024||value.includes("\0")||
    !isAbsolute(value)||resolve(value)!==value)denied();
  const path=value as string;
  try{
    const file=lstatSync(path),parent=lstatSync(dirname(path));
    if(realpathSync(path)!==path||!file.isFile()||file.isSymbolicLink()||
      file.nlink!==1||(file.mode&0o077)!==0||file.uid!==process.getuid?.()||
      !parent.isDirectory()||(parent.mode&0o022)!==0)denied();
    for(const root of excludedRoots){
      const rel=relative(realpathSync(root),path);
      if(!rel||rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel))denied();
    }
    return path;
  }catch{ return denied(); }
}
