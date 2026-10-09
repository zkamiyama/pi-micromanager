import test from "node:test";
import assert from "node:assert/strict";
import {directPublicationCommand} from "../dist/runtime/publication-guard.js";
test("Pi implementation guard blocks obvious direct publication through the shell",()=>{
  for(const command of [
    "git push origin HEAD",
    "git -C /tmp/worker push --porcelain origin HEAD:refs/heads/feature",
    "git -c push.default=current push origin feature",
    "echo prepared && gh pr create --draft",
    "gh pr merge --squash",
    "git \\\npush origin feature",
    "gh pr ready",
  ]){
    assert.equal(directPublicationCommand("bash",{command}),true,command);
  }
});
test("Regular Pi code editing, local commits and test invocation stay YOLO",()=>{
  for(const command of [
    "git status --porcelain",
    "git add . && git commit -m 'Implement endpoint'",
    "npm run check",
    "cat src/index.ts",
    "npx playwright screenshot http://localhost:3000 screenshots/ui.png",
  ])assert.equal(directPublicationCommand("bash",{command}),false,command);
  assert.equal(directPublicationCommand("read",{command:"git push"}),false);
  assert.equal(directPublicationCommand("bash",{foo:"git push"}),false);
});
