---
description: "将 pkg 运行时嵌入的原生 helper 可执行文件物化，供需要 DSH_HOME 下经过校验且可启动路径的调用方使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-executable-asset

[English](README.md) | 中文

## 概述

`dsh-executable-asset` 为打包运行时提供 pkg 虚拟文件系统中嵌入可执行文件的原生文件系统路径。它读取嵌入字节，以 SHA-256 寻址缓存，并在 `$DSH_HOME/cache/native-executables/` 下发布仅所有者可执行的文件。普通 Node 进程原样获得依赖路径。文件系统搜索和本地沙箱包用它处理 ripgrep 与 Landlock launcher。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

仅对依赖拥有的可执行文件路径调用此 helper。返回路径可直接传给子进程 API。

```ts
import { materializeExecutableAsset } from '@deepseek-ai/dsh-executable-asset'

const dependencyExecutablePath = '/absolute/path/from-dependency'
const executable = materializeExecutableAsset(dependencyExecutablePath)
```

在 pkg 之外，`executable` 等于输入路径。在 pkg 中，此调用校验或创建内容寻址缓存文件并返回该路径。读取、哈希、目录、权限或发布失败会传给调用方；此包绝不回退到未校验的可执行文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

此包在选择缓存目录前对完整嵌入字节进行哈希。有效的普通缓存文件会再次接受哈希校验并获得 `0700` 模式。缺失、损坏或符号链接条目通过独占临时同级文件和原子重命名进行替换。目标目录源自内容摘要，因此并发发布者提交的是等价字节。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | pkg 检测、哈希、缓存校验与原子可执行文件发布 |
| [`src/invariant.ts`](src/invariant.ts) | invariant companion；单元测试拥有无状态文件系统约定 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [主目录路径](../home-paths/README.zh.md)——拥有 `$DSH_HOME` 解析。
- [文件系统搜索](../../fs/tool-fs-search/README.zh.md)——不存在 sidecar 时物化嵌入的 ripgrep。
- [本地沙箱](../../sandbox/sandbox-local/README.zh.md)——物化嵌入的 Landlock launcher。

-----

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **缓存仅追加**——内容寻址的各代文件会保留，供正在运行及较旧的二进制使用；卸载文档拥有可选缓存删除说明。
- **来源必须是可信包内容**——此工具校验缓存与来源字节相等，但不负责建立来源包的真实性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
