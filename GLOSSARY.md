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
拥有 `dsh` 子进程的组件：启动它、把它的输出镜像成容器日志、持有它当前的 launch token、传播退出码。
_Avoid_: entrypoint, manager, wrapper

**Proxy**:
容器内位于浏览器与 DSH 之间的 HTTP/WS 反向代理，语义透明地转发请求，并替浏览器完成 launch token 交换。
_Avoid_: gateway, Caddy, relay

**Relay**:
现有的原始 TCP 端口转发层，只搬运字节、不解析 HTTP；Web proxy 上线后在 web 模式退役。
_Avoid_: proxy, forwarder
