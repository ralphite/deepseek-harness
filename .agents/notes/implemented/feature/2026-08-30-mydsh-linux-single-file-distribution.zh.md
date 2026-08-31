# Agent Note: mydsh Linux 单文件 GitHub 分发

Status: implemented

[English](2026-08-30-mydsh-linux-single-file-distribution.md) | 中文

## 问题

Linux 用户需要一种稳定的 `curl | sh` 安装方式，在无 Node、npm、pnpm 或 Python 的环境中提供 Web 与 CLI 应用。现有可执行文件流水线产出的是带相邻原生文件且命令名为 `dsh` 的 Python SDK 运行时，直接发布该目录无法满足单文件安装要求。

## 决策

现有 pkg 流水线为 glibc 2.28 或更新版本额外产出无伴随文件的 `mydsh-linux-x64` 与 `mydsh-linux-arm64`。Ripgrep 和 Landlock launcher 作为 pkg 资源内置。当打包进程不带 Python wheel 伴随文件时，对应 consumer 会对内置字节计算散列，校验已有缓存文件为普通非符号链接，否则将可执行文件原子写入 `$DSH_HOME/cache/native-executables/<sha256>/`。Python 运行时 wheel 保留外置原生文件并优先选择它们。

仅当可执行文件的精确打包基名为 `mydsh` 时，根命令、Web、Headless、SDK 与 ACP 帮助才使用 `mydsh`。npm bin 仍为 `dsh`，产品、profile、包与协议标识均不变。`CmdlineHost` 向应用帮助 consumer 传递只读 launcher 名称，并默认为 `dsh`。

[`scripts/install-mydsh.sh`](../../../../scripts/install-mydsh.sh) 将 Linux x86_64 与 arm64 主机映射到两个产物，拒绝非 glibc 系统和低于 glibc 2.28 的版本，下载显式版本及 `SHA256SUMS`，校验摘要，运行候选文件的 `--version`，再原子替换 `$HOME/.local/bin/mydsh` 或 `MYDSH_INSTALL_DIR/mydsh`。`MYDSH_VERSION` 可选择旧的已发布版本。脚本不修改 shell 配置、不请求 sudo，也不调用 GitHub latest-release API；检入的默认值就是推荐版本。

受保护的手动 GitHub workflow 根据显式版本输入构造 `mydsh-v<repository-version>`。当根版本或安装脚本默认值不一致，或标签、release 已存在时失败；它通过可执文件 workflow 构建两个原生 Linux 目标，检查产物集与 GLIBC 上限，并创建一个不覆盖的 prerelease，其中包含两个二进制和 `SHA256SUMS`。该发布系列可跳过仓库版本。

`mydsh plugin` 仍需要 pnpm，工具调用执行的命令仍由主机提供。这些可选主机能力不属于无依赖 Web、Headless、SDK 与 ACP 运行时范围。

## 已考虑的替代方案

**发布 Python 运行时目录。** 拒绝，因为 ripgrep 伴随文件会让安装与升级变成多文件操作。

**发布带原生 helper 的压缩包。** 拒绝，因为安装后的运行载荷必须只有一个可执行文件，且解压会新增一项必需的主机工具。

**安装时解析最新 GitHub release。** 拒绝，因为 prerelease 不提供稳定的 latest-release 约定，且可变查询会使一行安装变得不确定。

**重命名所有 `dsh` 标识。** 拒绝，因为 `mydsh` 是 GitHub launcher 名称，不是产品、包、profile 或线路协议重命名。

## 后果

用户在每个受支持的 Linux 架构上获得一个可原子替换的可执行文件，并可通过普通文件操作固定、升级或卸载。首次使用 ripgrep 或 Landlock 时会写入按内容寻址的可执行缓存，重用前会再次校验完整性。

发布的二进制体积较大，且仅支持 x86_64 与 arm64 上的 glibc 2.28 或更新版本；Alpine 和其他 musl 系统不受支持。发布操作者必须在不可变标签存在之前，以匹配版本显式调度受保护的 workflow；更改推荐 release 需要同时更改并验证安装脚本。

## 测试

安装脚本测试覆盖架构与 glibc 检测、版本与目录覆盖、校验和自检失败、保留已安装二进制、PATH 提示与临时文件清理。包测试覆盖 launcher 名称传递与可执行缓存完整性。发布 job 在原生 Linux 与 manylinux 2.28 中以无 Node、npm、pnpm 或 Python 的方式运行二进制，检查帮助与版本输出，执行 keyless Headless 与原生 helper 场景，并在同一 Harness home 上启动和重启 Web，同时由浏览器自动化拒绝页面与控制台错误。
