import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const at=(name)=>readFileSync(new URL('../.github/workflows/'+name,import.meta.url),'utf8');
const shaPins=/uses:\s+actions\/(?:checkout|setup-node)@([a-f0-9]{40})/g;

test('S06 mandatory release gates pin upstream action SHAs and never persist checkout credentials',()=>{
 const ci=at('ci.yml'),manual=at('authenticated-e2e.yml');
 const required=['build-and-test','successful-isolation'];
 for(const job of required)assert.match(ci,new RegExp('^  '+job+':','m'));
 assert.match(ci,/node: \['22', '24'\]/);
 assert.match(ci,/permissions:\s*\n  contents: read/);
 assert.match(ci,/cancel-in-progress: true/);
 for(const text of [ci,manual]){
  const pins=[...text.matchAll(shaPins)].map(x=>x[1]);
  assert.ok(pins.length>=2,'Checkout/setup-node must be pinned by full SHA');
  assert.equal(pins.some(p=>p.length!==40),false);
  assert.equal(text.includes('persist-credentials: false'),true);
  assert.doesNotMatch(text,/allow-unsafe-pr-checkout:\s*true/);
 }
 assert.match(ci,/MM_REQUIRE_SANDBOX:\s*'1'/);
 assert.match(ci,/production-server-isolation\.required\.mjs/);
 assert.match(ci,/runs-on: ubuntu-22\.04/);
 assert.doesNotMatch(ci,/privileged: true|apparmor.*disable|unshare-user.*false/i);
 assert.ok(existsSync(new URL('../package-lock.json',import.meta.url)));
 assert.match(ci,/npm ci --no-audit --no-fund/);
});

test('S06 authenticated E2E remains manual, default-branch-only, least privilege and non-publishing',()=>{
 const workflow=at('authenticated-e2e.yml');
 assert.match(workflow,/^on:\s*\n  workflow_dispatch:/m);
 assert.doesNotMatch(workflow,/^  (?:push|pull_request|schedule):/m);
 assert.match(workflow,/github\.event\.repository\.default_branch/);
 assert.match(workflow,/environment: authenticated-pi-e2e/);
 assert.match(workflow,/runs-on: ubuntu-22\.04/);
 assert.doesNotMatch(workflow,/runs-on: \[self-hosted/);
 assert.match(workflow,/inputs\.approve_billed_test && inputs\.test_identity_only/);
 assert.match(workflow,/REVIEWED_SHA: \$\{\{ inputs\.reviewed_sha \}\}/);
 assert.ok(workflow.includes('test "$REVIEWED_SHA" = "$RUN_SHA"'));
 assert.match(workflow,/ref: \$\{\{ github\.sha \}\}/);
 assert.ok(workflow.includes('--provider "$PI_PROVIDER" --model "$PI_MODEL"'));
 assert.match(workflow,/--expected-sha "\$EXPECTED_SHA" --approve-billed-test --test-identity-only/);
 assert.match(workflow,/secrets\.MM_E2E_API_KEY/);
 assert.doesNotMatch(workflow,/real-durable-autopilot-smoke\.mjs/);
 assert.match(workflow,/timeout --signal=TERM --kill-after=10s 90s/);
 assert.match(workflow,/permissions:\s*\n  contents: read/);
 assert.doesNotMatch(workflow,/contents: write|id-token: write|pull-requests: write/);
 assert.match(workflow,/no remote publication/i);
 const updates=readFileSync(new URL('../.github/dependabot.yml',import.meta.url),'utf8');
 assert.match(updates,/package-ecosystem: github-actions/);
 assert.match(updates,/package-ecosystem: npm/);
});
