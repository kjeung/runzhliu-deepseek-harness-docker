# DeepSeek Harness Docker

把官方 DeepSeek Harness（DSH）装进容器、并对外提供 Web UI 与浏览器桌面的部署仓库。

## Language

**Launch token**:
DSH 每个 web 进程生成的进程级 bearer 凭据，只出现在启动行 `dsh web: <url>/?token=…` 里，进程退出即失效、重启即轮换。
_Avoid_: API token, access token, 密码

**Session cookie**:
DSH 用 launch token 交换后签发的签名 cookie，绑定浏览器看到的 authority，跨 DSH 重启有效直到过期。
_Avoid_: token, session

**Supervisor**:
拥有 `dsh` 子进程的组件：启动它、把它的输出镜像成容器日志、持有它当前的 launch token、传播退出码；web 模式下在同一进程内加载 proxy，由 proxy 接管监听与转发。
_Avoid_: entrypoint, manager, wrapper

**Proxy**:
容器内位于浏览器与 DSH 之间的 HTTP/WS 反向代理，语义透明地转发请求，并替浏览器完成 launch token 交换。
_Avoid_: gateway, Caddy, relay

**Pinned version**:
构建镜像时固定的 DSH 版本（`DSH_VERSION`），admin 变体版本范围的下界，也是“已测试”的唯一口径来源。
_Avoid_: tested version, current version

**Tested version**:
仅指镜像构建时经 CI 实测的 pinned version；其他版本（含更新的 `next` 通道）一律 untested。
_Avoid_: proven, stable

**Relay**:
已退役的原始 TCP 端口转发层，只搬运字节、不解析 HTTP；#13 的进程内 forwarder 也随 #15 退役，web 模式改由 proxy 承担 HTTP/WS 语义，仅作为历史称谓保留。
_Avoid_: proxy, forwarder

**Retired dir**:
install 卷内 factory reset 的旁路目标：`.retired/<timestamp>/`，安装内容整体移入其中（move-aside，从不 delete）；npm 缓存、日志目录等基础设施不随移，会话数据（`~/.dsh`）与工作区卷亦不受触及（spec #16; decision #5）。
_Avoid_: backup dir, temp dir, 删除、清空
