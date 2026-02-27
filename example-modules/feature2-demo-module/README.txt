Feature 2 Demo Module
=====================

Local path:
  example-modules/feature2-demo-module

What this demo covers:
- Local install/import flow
- Duplicate import conflict prompt (import twice)
- Multiple actions with bound scripts
- Script-name collision handling:
  - actions/run.py and analysis/run.py both map to run-style names in tree
- Action parameter JSON entry + persisted module settings
- Health warnings:
  - dependency requirements are declared (warning-only in v1)
  - compatibility metadata is declared

Suggested manual test:
1) Modules -> Install Local -> select this folder.
2) Import the module.
3) Import it again to trigger alias conflict suggestion.
4) Run "Seed Demo Dataset" with:
   {"target_path":"demo.dataset","count":10,"start":2,"step":0.25}
5) Run "Summarize Demo Dataset" with:
   {"source_path":"demo.dataset","result_path":"demo.summary"}
6) Run "Annotate Dataset" with:
   {"source_path":"demo.summary","note":"reviewed","flagged":true}
7) Save project, reload project, return to module tab and confirm params persist.
