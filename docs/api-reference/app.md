# The App Object (`pdv`)

`pdv` is a session-level app object injected into the kernel namespace
alongside `pdv_tree`. It exposes operations that act on the running PDV
application rather than on project data.

```python
pdv.working_dir              # Path to the session working directory
pdv.save()                   # Save the project (prompts if no save path)
pdv.new_note('notes.intro')  # Create a markdown note at a tree path
pdv.help()                   # Print a quick reference
```

Tab-completing `pdv.` in a code cell lists every available operation.

::: pdv_kernel.namespace.PDVApp
    options:
      show_root_heading: true
      show_source: false
      members_order: source
      filters:
        - "!^_"

## Module authoring

Two additional attributes are attached to `pdv` at kernel startup:

- `pdv.handle` — decorator for registering double-click handlers on
  custom types. See the [Module API](module-api.md#pdvhandle).
- `pdv.register_serializer` — register save/load callbacks for types PDV
  does not know how to persist on its own. See the
  [Module API](module-api.md#pdvregister_serializer).

Both are only relevant when authoring a module library, which is why
they are documented there.
