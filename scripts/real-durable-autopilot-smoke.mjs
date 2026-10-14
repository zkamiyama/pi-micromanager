#!/usr/bin/env node
/** Retired unsafe compatibility test entrypoint; NOT a passing substitute.
 * Original implementation used ambient daemon auth, a default billed model,
 * unconfined coding tools and host-side tests. A qualified hosted/browser and
 * publication acceptance adapter is tracked in #92. Do not run it implicitly
 * on a credential-bearing runner. Actual production runtime is unchanged. */
process.stdout.write(JSON.stringify({schemaVersion:1,status:'blocked',
  code:'legacy-autopilot-smoke-unqualified',
  successor:'docs/E2E_ACCEPTANCE.md',trackingIssue:92,
  hostedPiWebBrowser:'not-tested',remotePublication:'not-tested',
  productionSafetyGuaranteed:false})+'\n');
process.exitCode=2;
