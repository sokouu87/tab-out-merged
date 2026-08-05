# Tab Out 远程查看器

这个服务把 Vivaldi 中 Tab Out 的实时标签快照保存在本机，并通过指令队列把手机上的“收藏”或“关闭”操作送回扩展。服务只监听 `127.0.0.1:8787`，公网访问必须经过现有的 Cloudflare Tunnel。

运行时只使用 Node.js 标准库，不需要执行 `npm install`，也没有 npm 运行时依赖。

## 1. 生成本机配置

在仓库根目录运行：

```powershell
node server/setup.mjs
```

按提示输入登录密码。脚本会生成被 Git 忽略的 `server/config.json`，并在终端打印 `extensionKey`。请把这个 key 暂时复制下来。

配置已存在时脚本不会覆盖。后续想改动，按需要选一种：

**只换登录密码**（最常用）——保留 `extensionKey` 和 `cookieSecret`，
所以扩展里不用重填 key，手机上已登录的会话也不会被踢掉：

```powershell
node server/setup.mjs --change-password
```

**换密码并把所有设备踢下线**——比如手机丢了。同样保留 `extensionKey`，
只重置 `cookieSecret`，已签发的登录 cookie 立即全部失效：

```powershell
node server/setup.mjs --change-password --revoke-sessions
```

**推倒重来**——密码、`cookieSecret`、`extensionKey` 全部重新生成。
注意这会让扩展里填的 key 作废，必须回设置里重新填一次：

```powershell
node server/setup.mjs --force
```

密码通过终端隐藏输入，不回显、不进命令历史。非交互场景（脚本、CI）可以临时用
`TAB_OUT_PASSWORD` 环境变量传入，但那样密码会留在进程环境里，日常不要这么用。

## 2. 配置扩展

1. 在 Vivaldi 打开 Tab Out，点击右上角齿轮。
2. 保持 Service URL 为 `http://localhost:8787`。
3. 填入 setup 打印的 `extensionKey`。
4. 打开 Remote sync。
5. Connection status 显示 Connected 后即同步成功。

刷新间隔同时控制桌面标签视图和远程快照周期。默认 30 秒；选 Manual 时不再周期推送快照，超过 90 秒后手机端会显示离线，直到扩展再次推送。

## 3. 启动服务

前台试运行：

```powershell
node server/server.mjs
```

服务正常时会显示：

```text
Tab Out 远程查看器已监听 http://127.0.0.1:8787
```

`server/data/snapshot.json` 和 `server/data/commands.json` 会自动创建并持久化；两者和配置文件都不会进入 Git。

## 4. 设置开机自启

以管理员 PowerShell 运行下面的脚本来注册计划任务：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\server\install-task.ps1
```

卸载计划任务：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\server\install-task.ps1 -Unregister
```

## 5. 添加 Cloudflare Public Hostname

这一步必须由用户在 Cloudflare Zero Trust 面板手动完成，不要修改本机 `cloudflared` 配置：

1. 进入 **Networks → Tunnels**。
2. 选中已经运行的隧道，点击 **Configure**。
3. 进入 **Public Hostname → Add**。
4. Subdomain 填 `tab`。
5. Domain 选 `sokouu.cc`。
6. Type 选 `HTTP`。
7. URL 填 **`127.0.0.1:8787`**。**不要填 `localhost:8787`。**
8. 保存后访问 `https://tab.sokouu.cc`，使用 setup 时输入的用户名和密码登录。

> **为什么必须写 `127.0.0.1` 而不是 `localhost`**
>
> Windows 上 `localhost` 同时解析到 IPv6 的 `::1` 和 IPv4 的 `127.0.0.1`，且 `::1` 排在前面。
> 本服务只监听 `127.0.0.1`（这是有意的安全边界，见下文），所以对 `::1` 的连接会被拒绝。
> curl 之类的客户端有 Happy Eyeballs 回退，试 `::1` 失败会自动改试 IPv4，看起来一切正常；
> **cloudflared 不回退**，直接返回 `error code: 502`。
>
> 症状是 `https://tab.sokouu.cc` 报 502，但本机 `curl http://localhost:8787` 却 200——
> 排查时很容易被这个不一致带偏。判据：`curl http://[::1]:8787` 连不上（HTTP 000）就是这个原因。

登录 cookie 有效期为 90 天。Cookie 带 `Secure`，因此完整登录流程应通过 `https://tab.sokouu.cc` 使用；直接访问本机 HTTP 地址只适合服务诊断。

## 安全边界

- 服务入口固定监听 `127.0.0.1`，不要改为 `0.0.0.0` 或 `::`。
- `server/config.json` 包含密钥，不要复制进提交、Issue 或聊天记录。
- 扩展默认关闭远程同步；没有有效 `extensionKey` 时不会连接服务。
- 浏览器快照超过 90 秒未更新时，手机端拒绝新增操作，避免离线期间积压破坏性指令。
