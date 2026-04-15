# Exceptions

Every exception raised by `pdv_kernel` inherits from `PDVError`, so user
code can catch all PDV-specific errors in a single clause:

```python
from pdv_kernel import PDVError

try:
    pdv_tree['results.bad.path'] = compute()
except PDVError as exc:
    print(f'PDV rejected the write: {exc}')
```

All exception types are importable from `pdv_kernel.errors`. `PDVError`
itself is also re-exported from the top-level `pdv_kernel` package.

---

::: pdv_kernel.errors.PDVError

---

::: pdv_kernel.errors.PDVPathError

---

::: pdv_kernel.errors.PDVKeyError

---

::: pdv_kernel.errors.PDVProtectedNameError

---

::: pdv_kernel.errors.PDVSerializationError

---

::: pdv_kernel.errors.PDVScriptError

---

::: pdv_kernel.errors.PDVVersionError
