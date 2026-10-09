# Micromanager trial repository

Disposable, dependency-free Node.js project for the
[Micromanager quick start](../../docs/QUICKSTART.md).

Baseline: `add(a,b)` is tested and passes. The sample DAG asks an authenticated
Pi implementation session to add `multiply(a,b)` and tests, then independent
QC, a final integration Pi run and independent final QC must all succeed.
The PR's `Trial CI` workflow supplies the GitHub check required by Micromanager
before its automatic GitHub merge.

**Only publish this to a disposable GitHub repository.** Never point the first
fully autonomous trial at your real production repository.
