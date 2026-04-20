# Exceptions

Every exception raised by `pdv` inherits from `PDVError`, so user
code can catch all PDV-specific errors in a single clause:

```python
from pdv import PDVError

try:
    pdv_tree['results.bad.path'] = compute()
except PDVError as exc:
    print(f'PDV rejected the write: {exc}')
```

All exception types are importable from `pdv.errors`. `PDVError`
itself is also re-exported from the top-level `pdv` package.

---

::: pdv.errors.PDVError

---

::: pdv.errors.PDVPathError

---

::: pdv.errors.PDVKeyError

---

::: pdv.errors.PDVProtectedNameError

---

::: pdv.errors.PDVSerializationError

---

::: pdv.errors.PDVScriptError

---

::: pdv.errors.PDVVersionError
