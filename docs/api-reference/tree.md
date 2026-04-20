# The Tree (`pdv_tree`)

`pdv_tree` is the live project data tree. It behaves like a Python `dict`
but with a few important differences:

- **Dot-paths.** Keys may contain `.` to address nested nodes:
  `pdv_tree['results.run_01.temperature']` resolves through intermediate
  dicts, creating them on write if needed.
- **Change notifications.** Assignments, deletions, and mutations are
  observed by the app; the UI tree panel refreshes automatically.
- **Persistence.** Everything stored in `pdv_tree` is serialized when the
  project is saved. Values outside the tree are not.

The tree is the sole source of truth for project data. Any state a user
wants to keep across sessions must live here.

::: pdv.tree.PDVTree
    options:
      show_root_heading: true
      show_source: false
      members_order: source
      inherited_members: false
      filters:
        - "!^_"
