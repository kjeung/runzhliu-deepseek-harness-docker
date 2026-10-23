# Admin 变体：uid 1000 + 只读根 + 命名卷下的 DSH 安装/切换

票：[#2](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/2)（map [#1](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/1)）。证据采集：2026-10-24。

问题：不引入 root 的前提下，admin 变体能否可靠地安装 / 切换官方 DSH？

## 结论：GO（附三个硬前提）

在 `read_only: true` + `USER 1000:1000` + `/opt/dsh` 命名卷下，用
`npm install --global --omit=dev --prefix /opt/dsh/versions/<v> @deepseek-ai/dsh@<v>`
（npm 11.19.1 / Node 24）可以安装、原地切换并运行，amd64 与 arm64 实机行为一致。

前提：

1. **卷的所有权必须是 1000:1000**。新建命名卷会从镜像里的 `/opt/dsh` 目录继承 owner；bind mount 不会，owner 不匹配时安装直接 EACCES 失败。
2. **npm cache 必须放在可写位置**（`NPM_CONFIG_CACHE`）。默认 `$HOME/.npm` 在只读根下不可建，安装当场失败。
3. **不依赖编译工具链**。node-pty / sharp / sherpa-onnx / koffi / node-addon-* 的 linux-x64 与 linux-arm64 预编译产物都在 tarball 里，`python3/make/g++` 不是安装前提（镜像里有也无害）。

## 方法

两条独立证据线，同一 uid（1000）、同一 Node 大版本（24）：

- **真容器**：`node:24-trixie` + `--read-only` + `--user 1000:1000` + `--cap-drop ALL` + `no-new-privileges` + `/opt/dsh` 命名卷 + `/tmp` tmpfs，在 CI 的 amd64 / arm64 原生 runner 上跑（[run amd64/arm64](https://github.com/kjeung/runzhliu-deepseek-harness-docker/actions/runs/40028772681)，throwaway 分支 `wayfinder/2-admin-install-spike`，跑完删除）。
- **本机**：uid 1000、overlay 文件系统、`npm --prefix` 装进普通目录，用来交叉验证 npm 层的行为与耗时量级。

## 证据

| 实验 | amd64 容器 | arm64 容器 | 本机 uid 1000 |
| --- | --- | --- | --- |
| 首次安装（rc.2） | 34.1 s / 38.7 s | 38.0 s / 42.7 s | 97 s（冷 cache） |
| 原地切到 rc.3 | 24.5 s / 20.3 s | 21.2 s / 23.5 s | 76 s |
| 同版本重装（no-op） | 22.4 s / 20.0 s | 20.6 s / 23.3 s | 60 s |
| 卷大小（含 cache） | 1.1–1.2 GB | 1.2 GB | 855 MB 安装 + 249 MB cache |
| 文件数 | 65 270 | 65 270 | 62 903 |
| npm cache | 249–252 MB | 252 MB | 249 MB |

（两条数字分别是两次 CI 跑的结果；本机耗时受 overlay I/O 影响，只用于量级对比。）

其它实测：

- 只读根、只读 `$HOME`、`/opt/dsh` 可写、`/tmp` tmpfs 可写，均符合预期。
- 切换后 `lib/node_modules/@deepseek-ai/` 下只剩一个 `dsh` 目录，没有旧版本残留；`bin/dsh` 是相对符号链接，指向 `../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- 从卷里直接运行：`/opt/dsh/bin/dsh --version` → `0.2.1-rc.2`；`dsh --help` 正常打印（说明不跑生命周期脚本时模块图也能加载）。
- 原生模块全部预编译，两种架构都在：node-pty `prebuilds/linux-{x64,arm64}/pty.node`、`@img/sharp-linux-*`、`sherpa-onnx-linux-*`、`@koromix/koffi-linux-*`（glibc + musl）、`@deepseek-ai/node-addon-system-linux-*`（glibc + musl）、`node-addon-require-builtin-linux-*-gnu`。卷里没有 `node-gyp` 产物。

## 关键发现

1. **cache 是第一个硬失败点**。只读根下不设 `NPM_CONFIG_CACHE`：
   `npm error path /home/node/.npm` / `ENOENT: no such file or directory, mkdir '/home/node/.npm'`，退出码 1。设成卷内 `.npm-cache` 后立即成功（34–43 s）。
2. **只读根下 npm 不写日志**：`Log files were not written due to an error writing to the directory: /home/node/.npm/_logs`。失败时现场只剩 stdout，admin 的可观测性必须显式把 `logs-dir` 指到可写位置。
3. **所有权不匹配是第二个硬失败点，且报错可检出**。bind mount 由宿主机 uid 1001 拥有、容器以 1000 运行：`PREFIX NOT WRITABLE`，npm `EACCES` / `syscall mkdir` / `path /opt/dsh/lib`，退出码 243，`bin/dsh` 不存在。`chown 1000:1000` 后同一命令退出码 0、版本可运行。**检测手段**：启动时 `stat` 前缀 owner + `test -w`，不要等 npm 报错。
4. **中断安装的现场不可信任**。SIGKILL 掉安装进程后，一次跑里旧版本仍可运行（`--version` 仍输出 rc.3），另一次跑里 `bin/dsh` 已经不在了（npm 在 reify 中先删后建）。两次重跑都恢复成功（19–22 s）。所以：不要把「上次版本还能跑」当作回滚保证，中断后只承认「重跑安装成功」。
5. **原地 `--prefix` 覆盖写，切换后旧版本不保留**。npm 直接替换 `lib/node_modules/@deepseek-ai/dsh`。想让 [#5](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/5) 的「自动回滚」可行，布局必须改成 `versions/<v>` + `current` 符号链接：安装写新目录、健康检查通过再 flip；回滚是再一次 flip，不需要网络、不需要重装。已验证 `current -> versions/<v>` 的相对 `bin/dsh` 能穿透符号链接解析，flip 与回滚各是一次符号链接操作。
6. **npm 11.19.1 默认拒绝生命周期脚本**（新行为，不需要显式 `--ignore-scripts`）：`node-pty`、`koffi`、`@deepseek-ai/dsh-subprocess-local`、`@google/genai`、`protobufjs` 的 install/postinstall 被跳过，安装照样成功，`node-pty` 仍能加载（`typeof p.spawn === "function"`），`dsh --help` 正常。规格里要显式写明这一点（保持默认拒绝 + 把跳过记进日志），否则升级 npm 版本后行为漂移。
7. **版本事实（交 [#10](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/10)）**：npm 上 37 个已发布版本**全是预发布**（alpha/beta/rc），没有 0.1.0 / 0.2.0 正式版；`dist-tags`：`latest=0.2.1-rc.2`、`next=0.2.1-rc.3`、`alpha=0.2.1-alpha.5`；包没有 `engines` / `os` / `cpu` 字段，`bin` 为 `dsh`，tarball 只有 20 个文件（薄壳，真依赖在 `@deepseek-ai/dsh-*` 里）。因此版本发现不能只读 `latest`，预检也不能靠 `engines`。
8. **磁盘规划**：单版本 855 MB–1.2 GB（是否含 cache），切换到新版本目录时两版本并存，本机中途观测到 1.3 GB，峰值按 ≈2.5 GB 算。建议卷 ≥3 GB 可用。
9. `TMPDIR` 默认 `/tmp`（tmpfs）可写，npm 临时目录不需要额外配置。

## 建议的卷布局与环境变量

```
/opt/dsh/
  versions/<version>/            # npm --prefix 目标（lib/node_modules/… + bin/dsh）
  current -> versions/<v>        # 原子切换点；PATH 只引用 current
  .npm-cache/                    # NPM_CONFIG_CACHE（249–252 MB）
  logs/                          # npm logs-dir，只读根下唯一的失败现场
```

- `PATH=/opt/dsh/current/bin:$PATH`：supervisor（[#13](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/13)）用 PATH 里的 `dsh`，切换只改符号链接，不重启容器也不需要改 PATH。
- `NPM_CONFIG_CACHE=/opt/dsh/.npm-cache`、npm `logs-dir=/opt/dsh/logs`（`HOME` 可以保持只读）。
- 安装命令（建议形状）：
  `npm install --global --omit=dev --no-audit --no-fund --prefix /opt/dsh/versions/<v> @deepseek-ai/dsh@<v>`
- 预检三件套（比装完再报错便宜得多）：前缀 owner 是 `1000:1000` 且 `test -w`；可用空间 ≥3 GB；registry 可达。
- 镜像内预置种子版本有意义（省首启网络与 30–40 s），但**不省 reify**：同版本重装仍要 ~20 s，所以种子只应作为「volumes 为空时的一次性初始化」，不能每次都跑。

## 未验证 / 不覆盖

- 离线 / air-gapped（需要预置 tarball 或带 cache 的卷）与私有 registry。
- musl 基础镜像：koffi / node-addon-system 有 musl 产物，但没有在 alpine 上跑过（本仓基础镜像是 trixie）。
- 并发安装（两个 admin 请求同时装）与锁。
- 安装后的长时运行稳定性：只验证了 `--version` / `--help`，运行期语义归 [#5](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/5) 与 [#6](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/6)。
- arm64 是原生 runner（非 QEMU），但只代表 GitHub 的 arm64 硬件。
- 卷里已有 root 拥有的旧安装（smanx / 旧 root 镜像留下的 `/opt/dsh`）如何迁移处置：未验证，建议作为 [#5](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/5) 的一个失败分支。
