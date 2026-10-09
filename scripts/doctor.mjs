#!/usr/bin/env node
/** Read-only prerequisites check. Does not print tokens, modify the repo, or start Pi. */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {resolve,join} from "node:path";

const args=process.argv.slice(2);
if(args.includes("--help")||args.includes("-h")){
  console.log("Usage: npm run doctor -- [--target /absolute/path/to/trial-repo]");
  console.log("Checks Node, Git, GitHub auth and optional PI WEB/Pi commands.");
  process.exit(0);
}
if(args.length!==0&&!(args.length===2&&args[0]==="--target")){
  console.error("Invalid arguments. Run npm run doctor -- --help");
  process.exit(2);
}
let failed=0;
function report(ok,message,required=true){
  console.log((ok?"[OK] ":(required?"[FAIL] ":"[WARN] "))+message);
  if(!ok&&required)failed++;
}
function run(file,argv,cwd){
  const result=spawnSync(file,argv,{cwd,encoding:"utf8",timeout:8000,
    stdio:["ignore","pipe","pipe"],maxBuffer:1024*512});
  return {ok:result.status===0,stdout:result.stdout??"",error:result.error};
}
const version=process.versions.node.split(".").map(Number);
report(version[0]>22||(version[0]===22&&version[1]>=19),
  "Node.js >=22.19 required (installed "+process.versions.node+")");
report(run("git",["--version"]).ok,"Git command available");
report(run("npm",["--version"]).ok,"npm command available");
report(run("gh",["--version"]).ok,"GitHub CLI (gh) available");
report(run("gh",["auth","status"]).ok,"GitHub CLI authenticated for host-side publication");
report(run("pi",["--version"]).ok,"Pi CLI available on this PATH",false);
report(run("pi-web",["--version"]).ok,
  "PI WEB CLI available on this PATH (may be managed by another service user)",false);
report(existsSync(resolve("dist/pi-web/server.js"))&&
       existsSync(resolve("dist/runtime/companion.js")),
  "Micromanager built (run npm run build)");
if(args.length===2){
  const target=resolve(args[1]);
  const root=run("git",["rev-parse","--show-toplevel"],target);
  report(root.ok,"Trial target is a Git checkout: "+target);
  if(root.ok){
    report(root.stdout.trim()===target,"Target is exact Git root");
    const status=run("git",["status","--porcelain"],target);
    report(status.ok&&status.stdout.trim()==="","Target Git working tree is clean");
    const remote=run("git",["remote","get-url","origin"],target);
    report(remote.ok&&/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(remote.stdout.trim()),
      "Origin is a GitHub remote");
    const branch=run("git",["symbolic-ref","--short","HEAD"],target);
    report(branch.ok&&branch.stdout.trim()==="main",
      "Target currently on main (change publication.baseBranch if different)",false);
    const ci=run("git",["ls-files",".github/workflows"],target);
    report(ci.ok&&ci.stdout.trim()!=="",
      "PR CI workflow committed; unattended merge requires at least one passing check");
    const author=run("git",["var","GIT_AUTHOR_IDENT"],target);
    report(author.ok,"Git author identity configured");
  }
}
console.log(failed===0?"Preflight prerequisites passed. Authenticate Pi in PI WEB and confirm the model IDs before Start.":
  "Preflight failed. Correct the required items before trying autonomous publication.");
process.exit(failed===0?0:1);
