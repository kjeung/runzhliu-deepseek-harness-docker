# Security Policy

## Supported versions

Only the DSH version currently pinned by the default `DSH_VERSION` build argument is tested. This project tracks release candidates and does not promise backward compatibility.

## Deployment boundary

DeepSeek Harness Web uses a process launch token, signed browser cookie, and Host/Origin checks, and can initiate code execution through Agent tools. The in-container proxy completes the launch-token exchange for any client that can reach its listener, so the launch token is **not** an access boundary on that listener: the deployment boundary is network reachability plus whatever external reverse proxy/SSO the operator places in front. The image uses HTTP by default and publishes host loopback only; the default supported deployment is a trusted, single-user instance accessed through host loopback or `kubectl port-forward`.

Remote access is the operator's external reverse proxy/SSO: it terminates TLS, forwards the browser `Host` verbatim, and declares the authority in `DSH_TRUSTED_HOSTS` (the single list shared by DSH and the proxy). Ports 3080 and 6080 remain bound to host loopback, and the native noVNC endpoint must not be published directly. A host firewall should restrict source networks.

Rootless Podman deployments must use `compose.podman.yaml` with `podman-compose 1.6.0` or newer. Its `keep-id` mapping preserves the image's non-root UID 1000 while making a selected host workspace writable, and its `:Z` suffix privately relabels that workspace on SELinux hosts. Never aim that bind mount at a shared home directory, filesystem root, or directory used by unrelated containers.

On Docker hosts where Landlock is genuinely unavailable, the optional `compose.bwrap.yaml` overlay selects the separately tagged bubblewrap image. It retains the non-root user, read-only root filesystem, dropped capabilities, and `no-new-privileges`, but relaxes the container seccomp and system-path masks so bubblewrap can create its inner namespaces. Prefer enabling Landlock when the kernel already provides it, and use this fallback only on trusted single-user Docker hosts with unprivileged user namespaces enabled. The fallback is not supported for rootless Podman or Kubernetes.

The proxy and any external gateway do not make Harness multi-tenant. All authenticated users share the same settings, credentials, sessions, workspace access, and Agent code-execution authority. Mutually untrusted users require separate instances and separate state/workspace volumes.

Public Ingress, LoadBalancer, NodePort, unrestricted `-p 3080:3080`, direct publication of noVNC, forwarding the container's listener to the public Internet, shared untrusted-user access, Docker socket mounts, and privileged containers are outside the supported security model.

The optional `market` image variant contains a third-party community catalog and installer. It is not part of the default image and does not imply review or endorsement of listed plugins. Keep package build scripts blocked until reviewed, restrict container egress where practical, and treat every installed plugin as code running with the Harness process's access to the workspace and persisted profile.

From DSH `0.2.1-alpha.2`, the application itself binds container loopback. The entrypoint spawns a supervisor that owns the `dsh` child and loads a same-process HTTP/WS proxy on one concrete container interface address, never a wildcard Web listener. The supervisor mirrors `dsh` output into the container log and holds the current launch token in memory only; the proxy performs the transparent token exchange, enforces the Host gate, and never injects `X-Forwarded-*`. Ambiguous address selection fails closed; use `DSH_WEB_RELAY_INTERFACE` only to select the intended container interface. Host networking is unsupported. This listener is not an authentication or TLS gateway and must not be published directly beyond host loopback.

## Reporting

Do not publish credentials, session content, private workspace paths, or exploitable deployment details in a public issue. Report vulnerabilities privately to the repository owner through GitHub Security Advisories. Report vulnerabilities in DeepSeek Harness itself through the upstream project's security channel.
