---
description: "Materialization of native helper executables embedded in pkg runtimes for callers that need a verified spawnable path under DSH_HOME."
kind: "package-library"
---

# @deepseek-ai/dsh-executable-asset

English | [中文](README.zh.md)

## Summary

`dsh-executable-asset` gives a packaged runtime a native filesystem path for an executable embedded in pkg's virtual filesystem. It reads the embedded bytes, addresses the cache by SHA-256, and publishes an owner-only executable under `$DSH_HOME/cache/native-executables/`. Ordinary Node processes receive the dependency path unchanged. The filesystem-search and local-sandbox packages use it for ripgrep and the Landlock launcher.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call the helper only for a dependency-owned executable path. The returned path can be passed directly to a subprocess API.

```ts
import { materializeExecutableAsset } from '@deepseek-ai/dsh-executable-asset'

const dependencyExecutablePath = '/absolute/path/from-dependency'
const executable = materializeExecutableAsset(dependencyExecutablePath)
```

Outside pkg, `executable` equals the input path. Inside pkg, the call verifies or creates the content-addressed cache file and returns that path. Read, hash, directory, permission, and publication failures propagate to the caller; the package never falls back to an unverified executable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package hashes complete embedded bytes before choosing a cache directory. A valid regular cache file is hashed again and receives mode `0700`. A missing, corrupt, or symlinked entry is replaced through an exclusive temporary sibling and atomic rename. Concurrent publishers commit equivalent bytes because the target directory is derived from the content digest.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | pkg detection, hashing, cache verification, and atomic executable publication |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion; unit tests own the stateless filesystem contract |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Home paths](../home-paths/README.md) — owns `$DSH_HOME` resolution.
- [Filesystem search](../../fs/tool-fs-search/README.md) — materializes embedded ripgrep when no sidecar exists.
- [Local sandbox](../../sandbox/sandbox-local/README.md) — materializes the embedded Landlock launcher.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The cache is append-only** — content-addressed generations remain available to running and older binaries; uninstall documentation owns optional cache removal.
- **The source must be trusted package content** — this utility verifies cache equality with its source bytes but does not establish the source package's authenticity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
