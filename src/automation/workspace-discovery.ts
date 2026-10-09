/** Version-checked bridge to PI WEB's on-demand Git Workspace discovery.
 * Tested against PI WEB v1.202610.1. The Git Workspace provider uses an
 * absolute Git worktree path as its key; the registry derives SHA1 of
 * projectId + ":" + key, truncated to 12 hex characters. This is NOT
 * a public ID ABI. Always validate through the host's public resolve() API.
 * If the host changes its scheme or provider, fail closed without a Pi Run.
 */
import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";

export async function resolveManagedGitWorkspace(
  api:PiWebHostWorkspacesV1,projectId:string,path:string):Promise<string>{
  if(!projectId||!isAbsolute(path))
    throw new Error("Managed PI WEB Workspace requires an absolute Worktree path");
  const expectedPath=resolve(path);
  const candidate=createHash("sha1").update(projectId+":"+expectedPath)
    .digest("hex").slice(0,12);
  let authority;
  try{authority=await api.resolve({projectId,workspaceId:candidate});}
  catch{
    throw new Error("PI WEB did not discover the created Git Worktree. "+
      "The Git provider / Workspace ID scheme may differ. "+
      "Verify PI WEB version and provider; do not guess another ID.");
  }
  if(authority.project.id!==projectId||authority.workspace.id!==candidate||
    authority.workspace.projectId!==projectId||
    resolve(authority.workspace.path)!==expectedPath||
    authority.workspace.isMain||
    authority.workspace.provider?.metadata?.isGitWorktree!==true)
    throw new Error("PI WEB Workspace authority does not match the created Git Worktree");
  return candidate;
}
