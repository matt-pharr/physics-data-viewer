# Installation

PDV ships as a desktop app plus a Python kernel package. The app installer is downloadable via [releases](https://github.com/matt-pharr/physics-data-viewer/releases/latest); the kernel package (`pdv-python`) is bundled with the app and installed into a Python environment of your choice the first time you use it.

## Prerequisites

- **Operating system.** macOS (Apple Silicon) or Linux (x86_64). Windows support is planned but not yet released.
- **Python ≥ 3.10** available somewhere on your system. This can be a conda environment, a virtualenv, `pyenv`, or a system Python — PDV auto-detects all of these.
- **Internet connection** for the initial app download and for fetching the kernel's Python dependencies (primarily `ipykernel`) on first install.

!!! info "`pdv-python` is bundled with the app" 
    The kernel package is not published on PyPI. PDV installs it into the environment you pick on first launch using the copy that ships inside the app bundle — there is no separate install step for you to run.

---

## 1. Download the app

Grab the latest release for your platform from the
[releases page](https://github.com/matt-pharr/physics-data-viewer/releases/latest).

=== "macOS (Apple Silicon)"

    Download `PDV-<version>-arm64.dmg`. Double-click to mount, then drag **PDV** into `Applications`.

    Intel Macs are not currently supported; the arm64 build is the only macOS target. If you use an Intel Mac, you can request an Intel build by [opening an issue](https://github.com/matt-pharr/physics-data-viewer/issues/new).

=== "Linux"

    Three formats are available; pick whichever fits your distro:

    - **AppImage** — `PDV-<version>.AppImage`. Make it executable and run it directly:
      ```bash
      chmod +x PDV-*.AppImage
      ./PDV-*.AppImage
      ```
    - **.deb** — for Debian/Ubuntu: `sudo apt install ./PDV_*.deb`
    - **.rpm** — for Fedora/RHEL: `sudo dnf install ./PDV-*.rpm`

=== "Windows"

    Not yet released. Planned for mid 2026.

---

## 2. First launch

Open PDV. You will land on the **Welcome screen** with three options:

- **New Python Project**
- **New Julia Project (experimental)** — Julia support is early and pdv-julia is not yet bundled with the app. If you want to try it out, [open an issue](https://github.com/matt-pharr/physics-data-viewer/issues/new).
- **Open Project…**

Pick **New Python Project**. If this is your first time, PDV will open the **Environment Selector** before starting a kernel.

---

## 3. Pick a Python environment

The Environment Selector lists every Python interpreter PDV can find.
It searches, in order:

1. The path you configured previously (if any)
2. The currently-active conda environment (`$CONDA_PREFIX`)
3. The currently-active virtualenv (`$VIRTUAL_ENV`)
4. All conda environments known to `conda env list`
5. `pyenv` versions in `~/.pyenv/versions/`
6. System `python3` / `python` on `$PATH`

Each environment shows two status badges:

| Badge | Meaning |
|-------|---------|
| **`pdv`** 🟢 | `pdv-python` is installed and its version matches the app. |
| **`pdv`** 🟡 | `pdv-python` is installed but the version does not match. A reinstall will be offered. |
| **`pdv`** 🔴 | `pdv-python` is not installed. |
| **`ipy`** 🟢 | `ipykernel` is installed. |
| **`ipy`** 🔴 | `ipykernel` is missing. It will be pulled in when `pdv-python` is installed. |

If none of the detected environments are what you want, use **Browse…** to point PDV at a specific `python` executable. The GUI will install `pdv-python` into that environment pending your confirmation.

---

## 4. Install `pdv-python`

Select the environment you want to use. If either badge is red or yellow, an **Install pdv-python** button appears. Click it — PDV installs the bundled kernel package into the selected environment and streams the output into the selector panel. When it finishes and both badges are green, the **Confirm** button lights up.

That's it. PDV opens a new project window and your kernel starts.

!!! note "Version pinning"
    The `pdv-python` version must match the app version exactly during the `0.x` app versions. Full release `1.0` will have a more flexible compatibility policy to allow for backwards-compatiblity with projects, but generally future kernel versions will remain backwards-compatible with older projects. Breaking changes to the kernel API will be rare and will be bundled with a major app release (e.g. `2.0`); the app will include a migration tool for old projects if needed.

---

## 5. You're done

Head to the [User Guide](../user-guide/index.md) to learn how the Tree works, or dive into [Scripts & the Tree](../user-guide/scripts-and-tree.md) if you want to start running code right away.

---

## Troubleshooting

??? question ""No Python environments found""

    PDV did not find any Python interpreter it could use. Either:

    - Install a Python distribution (we recommend
      [miniconda](https://github.com/conda-forge/miniforge) for managing environments), or
    - Click **Browse…** and point PDV at an existing `python` executable.

    Future releases will ship with a bundled [uv](https://docs.astral.sh/uv/) installer to use a virtual environment per-project.

??? question "`pdv-python` version mismatch after upgrading PDV"

    When you upgrade the app, the bundled `pdv-python` version moves with it, so any environment that was green before the upgrade will now show a yellow badge. Select the environment and click **Install pdv-python** to update it in-place.

??? question "Install step fails with a pip error"

    The full pip output is shown in the selector panel — check it for the real error. Common causes:

    - **Python < 3.10.** `pdv-python` requires Python 3.10 or newer. Pick a different environment or upgrade the interpreter.
    - **No internet.** The `pdv-python` package itself is bundled with the app, but its dependencies (primarily `ipykernel`) are pulled from PyPI on first install. If you are on an air-gapped machine, pre-install `ipykernel` into your target environment before running PDV's install step.
    - **Read-only environment.** Some system-managed Python installs (e.g. `/usr/bin/python3` on macOS) refuse to install packages. Create a venv or [miniconda](https://docs.conda.io/en/latest/miniconda.html) env instead.

??? question "macOS: "PDV is damaged and can't be opened""

    This is a macOS quarantine issue. Remove the quarantine attribute:

    ```bash
    xattr -dr com.apple.quarantine /Applications/PDV.app
    ```

    If this happens, please [open an issue](https://github.com/matt-pharr/physics-data-viewer/issues/new) with your macOS version and the exact error message.

??? question "Still stuck?"

    [Open an issue](https://github.com/matt-pharr/physics-data-viewer/issues/new)
    with the environment selector screenshot and the error output. Include
    your OS, Python version, and PDV version (Help → About).
