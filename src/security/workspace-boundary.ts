/** Canonical filesystem separation is checked at the host capability boundary.
 * A Workspace containing state is as unsafe as a Workspace inside that state. */
import {lstatSync,realpathSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {isWithin,assertProductionProject,type ProductionPolicy} from "./policy.js";
export function assertWorkspaceBoundary(policy:ProductionPolicy,project:string,
  workspace:string,stateRoot:string,packageRoot:string):string {
  assertProductionProject(policy,project);
  const canonical=realpathSync(workspace),state=realpathSync(stateRoot),code=realpathSync(packageRoot);
  if(canonical!==resolve(workspace)||!lstatSync(workspace).isDirectory())
    throw new Error("Production Workspace must be a canonical directory");
  if(isWithin(canonical,state)||isWithin(canonical,code)||isWithin(code,canonical))
    throw new Error("Workspace overlaps control-plane state or executable package");
  const managedRoot=join(state,"managed-worktrees");
  const managed=isWithin(managedRoot,canonical)&&
    /^[a-f0-9]{16}\/[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/.test(relative(managedRoot,canonical));
  if(isWithin(state,canonical)&&!managed)
    throw new Error("Only an exact managed Worktree leaf may be mounted from the state root");
  const selected=realpathSync(project);
  if(!isWithin(selected,canonical)&&!managed)
    throw new Error("Workspace is outside its selected project or exact managed Worktree root");
  // Refuse both entry into another allowlisted project and a Workspace
  // enclosing another project. Outer Workspaces could otherwise inspect or
  // modify the nested project's files while using an authorized parent ID.
  if(policy.projectRoots.some(root=>root!==selected&&
    (isWithin(root,canonical)||isWithin(canonical,root))))
    throw new Error("Workspace overlaps a different authorized project");
  return canonical;
}
