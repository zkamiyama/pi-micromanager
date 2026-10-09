/** Deterministic workflow action permissions. */
export const PERMISSION_ACTIONS=[
  "git.commit","git.integrate","git.push","github.pr.create","github.pr.merge","deploy.production",
] as const;
export type PermissionAction=typeof PERMISSION_ACTIONS[number];
export type PermissionDecision="allow"|"ask"|"deny";
export interface WorkflowPermissions {
  default?:PermissionDecision;
  actions?:Partial<Record<PermissionAction,PermissionDecision>>;
}
export function permissionDecision(permissions:WorkflowPermissions|undefined,
  action:PermissionAction):PermissionDecision {
  const specified=permissions?.actions?.[action];
  if(specified)return specified;
  if(action==="github.pr.merge"||action==="deploy.production")
    return permissions?.default==="deny"?"deny":"ask";
  return permissions?.default??"allow";
}
export function validatePermissions(value:unknown):asserts value is WorkflowPermissions {
  if(value===undefined)return;
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new Error("Permissions must be an object");
  const policy=value as Record<string,unknown>;
  if(Object.keys(policy).some(k=>k!=="default"&&k!=="actions"))
    throw new Error("Unknown permission policy field");
  if(policy.default!==undefined&&!["allow","ask","deny"].includes(String(policy.default)))
    throw new Error("Invalid default permission");
  if(policy.actions===undefined)return;
  if(!policy.actions||typeof policy.actions!=="object"||Array.isArray(policy.actions))
    throw new Error("Invalid permission action map");
  for(const [action,decision] of Object.entries(policy.actions)){
    if(!(PERMISSION_ACTIONS as readonly string[]).includes(action))
      throw new Error("Unknown permission action "+action);
    if(decision!=="allow"&&decision!=="ask"&&decision!=="deny")
      throw new Error("Invalid permission decision for "+action);
  }
}
