/** Git's argv is not sufficient isolation: hooks/fsmonitor/signing execute code. */
export const SAFE_GIT_CONFIG:ReadonlyArray<readonly [string,string]>=Object.freeze([
  ["core.hooksPath","/dev/null"],["core.fsmonitor","false"],["commit.gpgsign","false"],
  ["tag.gpgsign","false"],["gc.auto","0"],["maintenance.auto","false"],
]);
export function gitExecutionEnvironment(inherited:NodeJS.ProcessEnv=process.env):{
  env:Record<string,string>;unsetEnv:string[];
}{
  const env:Record<string,string>={GIT_CONFIG_COUNT:String(SAFE_GIT_CONFIG.length),
    GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1"};
  SAFE_GIT_CONFIG.forEach(([key,value],i)=>{env["GIT_CONFIG_KEY_"+i]=key;env["GIT_CONFIG_VALUE_"+i]=value;});
  const unsetEnv=Object.keys(inherited).filter(k=>
    (/^GIT_CONFIG(?:_|$)/.test(k)||["GIT_EXTERNAL_DIFF","GIT_DIFF_OPTS","GIT_COMMON_DIR",
      "GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE","GIT_REPLACE_REF_BASE","GIT_QUARANTINE_PATH","GIT_PREFIX"].includes(k))&&!Object.hasOwn(env,k));
  return {env,unsetEnv};
}
export function assertPassiveRepositoryConfig(names:string):void{
  const forbidden=/^(?:include\.|includeif\.|filter\.|credential\.|url\.|http\.|core\.(?:sshcommand|askpass|gitproxy)|gpg\.|diff\..*\.(?:command|textconv)|merge\..*\.driver|remote\..*\.(?:proxy|uploadpack|receivepack|vcs)|extensions\.worktreeconfig)/i;
  for(const name of names.split(/[\n\0]/).filter(Boolean)){
    if(forbidden.test(name))throw new Error("Executable or redirecting repository Git configuration is forbidden in production: "+name.slice(0,120));
  }
}
