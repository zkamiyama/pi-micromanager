# Contributor guidance (small on purpose)

Read `README.md` and the ADR relevant to your change. Keep this file small: roles, DAG state and policies belong to code and structured records, **not** long agent-personality instructions.

- Write repository documentation, code comments, commit messages, and PR/Issue explanations in English. Preserve historical evidence and explicit scope/verification limits when translating.
- Follow the public Pi and PI WEB SDK contracts; avoid importing private PI WEB routes or internals.
- `src/core/` must have no Pi/PI WEB dependency and must be deterministic. Changing an action requires tests and, if semantics change, an ADR update.
- User interventions must become durable before any automatic next transition. Never bypass a `held` node or auto-merge without authorization.
- Never store OAuth tokens, secrets, full private model reasoning, or endless duplicate transcripts in MAMC.
- Distinguish **simulation UI** from actual running agents. TTS is explicitly the last milestone.
- Run `npm run check` and report constraints when dependencies or tests cannot run.
