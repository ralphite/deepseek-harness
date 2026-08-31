# Agent Note: mydsh Linux single-file GitHub distribution

Status: implemented

English | [中文](2026-08-30-mydsh-linux-single-file-distribution.zh.md)

## Problem

Linux users need a stable `curl | sh` installation that provides the Web and CLI applications without Node, npm, pnpm, or Python. The existing executable pipeline produces a Python SDK runtime with adjacent native files and the `dsh` command identity, so publishing that directory does not meet the one-file installation requirement.

## Decision

The existing pkg pipeline emits `mydsh-linux-x64` and `mydsh-linux-arm64` as additional sidecar-free artifacts for glibc 2.28 or newer. Ripgrep and the Landlock launcher are pkg assets. When a packaged process has no Python-wheel sidecar, the owning consumer hashes the embedded bytes, verifies an existing regular non-symlink cache file, and otherwise writes the executable atomically under `$DSH_HOME/cache/native-executables/<sha256>/`. Python runtime wheels retain their external native files and select them first.

The packaged agent-preset scanner enumerates embedded directory names and reads each entry with `lstat`. pkg 6.21.0's SEA virtual filesystem returns names even when `readdir` requests `withFileTypes`, so treating those results as `Dirent` objects prevents every Web Workspace from creating its initial Session.

The executable uses `mydsh` in root, Web, Headless, SDK, and ACP help only when its exact packaged basename is `mydsh`. The npm bin remains `dsh`, and product, profile, package, and protocol identities do not change. `CmdlineHost` passes the read-only launcher name to application help consumers and defaults to `dsh`.

[`scripts/install-mydsh.sh`](../../../../scripts/install-mydsh.sh) maps Linux x86_64 and arm64 hosts to the two assets, rejects non-glibc and glibc older than 2.28, downloads an explicit version plus `SHA256SUMS`, verifies the digest, runs the candidate's `--version`, and atomically replaces `$HOME/.local/bin/mydsh` or `MYDSH_INSTALL_DIR/mydsh`. `MYDSH_VERSION` selects an older published version. The script never modifies shell configuration, requests sudo, or calls the GitHub latest-release API; its checked-in default is the recommended version.

A protected, manually dispatched GitHub workflow constructs `mydsh-v<repository-version>` from its explicit version input. It fails when the root version or installer default differs or when the tag or release already exists, builds both native Linux targets through the executable workflow, checks the asset set and GLIBC ceiling, and creates a non-overwriting prerelease containing both binaries and `SHA256SUMS`. The release series may skip repository versions.

`mydsh plugin` still requires pnpm, and commands invoked by tools remain host-provided. Those optional host capabilities are outside the dependency-free Web, Headless, SDK, and ACP runtime.

## Alternatives considered

**Publish the Python runtime directory.** Rejected because its ripgrep sidecar makes installation and upgrades multi-file operations.

**Publish an archive with native helpers.** Rejected because the installed runtime payload must be one executable and archive extraction adds another required host tool.

**Resolve the newest GitHub release during installation.** Rejected because prereleases do not provide a stable latest-release contract and a mutable lookup makes the one-line installer nondeterministic.

**Rename every `dsh` identity.** Rejected because `mydsh` is a GitHub launcher name, not a product, package, profile, or wire-protocol rename.

## Consequences

Users receive one atomic executable per supported Linux architecture and may pin, upgrade, or uninstall it with ordinary files. First use of ripgrep or Landlock writes a content-addressed executable cache whose integrity is rechecked before reuse.

The published binaries are large and support only glibc 2.28 or newer on x86_64 and arm64; Alpine and other musl systems are unsupported. A release operator must deliberately dispatch the protected workflow with a matching version before its immutable tag exists, and changing the recommended release requires changing and validating the installer.

## Testing

Installer tests cover architecture and glibc detection, version and directory overrides, checksum and self-test failures, preservation of an installed binary, PATH guidance, and temporary-file cleanup. Package tests cover launcher-name propagation and executable-cache integrity. Release jobs run the binary without Node, npm, pnpm, or Python on native Linux and manylinux 2.28, check help and version output, execute keyless Headless and native-helper scenarios, create and select a usable Web Workspace and initial Session through the browser, then restart against the same Harness home and require that state to remain usable without page or console errors.
