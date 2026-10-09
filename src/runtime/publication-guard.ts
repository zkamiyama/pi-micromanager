/** Defense in depth against accidental direct publishing from a Pi coding Run.
 * This is NOT a shell sandbox: composed scripts, arbitrary binaries and
 * network-capable extensions still require OS-level credential isolation.
 * The host publisher is the only authoritative permission gate. */
export function directPublicationCommand(toolName:string,input:unknown):boolean{
  if(!["bash","shell","terminal","shell_command","exec_command"].includes(toolName))return false;
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const raw=input as Record<string,unknown>;
  const command=typeof raw.command==="string"?raw.command:
    typeof raw.cmd==="string"?raw.cmd:undefined;
  if(!command)return false;
  // Handles direct CLI forms, script pipelines and line-continuations.
  // Not a substitute for denying network credentials to untrusted processes.
  const normalized=command.replace(/\\\s*\n/g," ").replace(/[\t\n\r]+/g," ");
  return /(?:^|[\s;&|()])git(?:\s+(?:-C\s+[^\s;&|()]+|-c\s+[^\s;&|()]+|--no-pager))*\s+(?:push|send-pack|receive-pack)\b/i.test(normalized)||
    /(?:^|[\s;&|()])gh\s+pr\s+(?:create|merge|ready|edit|close)\b/i.test(normalized);
}
