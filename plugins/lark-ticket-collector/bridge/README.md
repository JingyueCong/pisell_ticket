# 飞书工单桥接服务

这个服务把 `lark-ticket-collector` 变成一个员工全程在飞书里使用的机器人。它通过飞书长连接接收群聊或私聊消息，下载随消息发送的附件，调用无界面的 Codex 工单 Agent，并把预览、确认提示或最终工单链接回复到原消息。

员工不需要安装任何东西。服务端需要长期在线；这里的“完全放在飞书上”指交互入口与结果都在飞书内，不代表代码在飞书客户端中运行。

## 已实现的边界

- 支持私聊和群聊 @ 机器人，支持文字、图片和常见消息附件。
- 按 `chat_id + sender_open_id` 隔离上下文，允许用户在下一条消息中回复“仍创建”或“确认更新 #工单号”。
- 复用插件现有的类型路由、查重、创建/更新授权、附件归档和流程就绪检查。
- SQLite 记录消息状态并按飞书 `message_id` 幂等。同一消息失败后不会自动重放，以免外部写入结果不明时重复建单。
- 附件落盘后记录 SHA-256；附件和截图内容一律按不可信业务证据处理，不能覆盖系统规则。
- 可用群、可用员工、是否必须 @ 机器人都由环境变量限制。

## 架构

```text
飞书员工
  -> 飞书自建应用机器人（im.message.receive_v1，长连接）
  -> bridge（白名单、附件下载、排队、幂等、会话记录）
  -> codex exec（lark-ticket-collector 插件）
  -> Meegle / lark-cli
  -> 回复原飞书消息
```

当前后端使用本机 `codex exec`，因此会直接复用这套插件和工作区规则。`AgentBackend` 已单独抽象，后续如需把运行层替换为 OpenAI Agents SDK，不需要改飞书接入与幂等存储。

## 1. 准备飞书应用

在飞书开放平台创建企业自建应用并启用机器人能力：

1. 在权限管理中至少申请 `im:message`、`im:message:send_as_bot`、`im:resource` 和 `im:chat.members:read`。如果机器人只接收群内 @ 消息，可按飞书控制台提示申请对应的群 @ 消息权限；如果要读取群内所有消息，需申请更高范围的群消息权限。
2. 在事件订阅中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
3. 发布应用版本并通过管理员审核。
4. 将机器人加入准备用于收单的群；机器人必须有发言权限。
5. 记录 App ID、App Secret、允许触发机器人的群 `chat_id` 和员工 `open_id`。

生产环境建议同时配置群和发送人白名单。留空 `ALLOWED_SENDER_IDS` 会允许白名单群内的所有成员；群和发送人都留空会显著扩大入口范围。

## 2. 准备服务端

需要 Node.js 22+、Codex CLI、Meegle CLI 和 `lark-cli`。先在服务账号下完成认证：

```bash
codex --version
meegle auth login --host project.feishu.cn
lark-cli --profile ticket-collector whoami
```

将整个 `lark-ticket-collector` 插件安装到该服务账号的 Codex 环境，不能只复制主 Skill，因为它会读取同插件内的 Meegle 技能和策略文件。

安装桥接服务依赖，并创建专用工作区：

```bash
cd bridge
npm ci
npm run workspace:init -- /srv/pisell-ticket-workspace
```

`workspace:init` 默认拒绝覆盖已有 `AGENTS.md` 或配置。如果目标路径已有文件，请先人工合并业务规则，不要直接删除。

## 3. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=your_secret
LARK_CLI_PROFILE=ticket-collector
ALLOWED_CHAT_IDS=oc_xxx
ALLOWED_SENDER_IDS=ou_xxx,ou_yyy
REQUIRE_MENTION=true
YOKO_HANDOFF_CHAT_ID=oc_yoko_group
CONTENT_PRODUCER_SOURCE_CHAT_ID=oc_content_group
BRIDGE_WORKSPACE=/srv/pisell-ticket-workspace
```

关键项：

- `REQUIRE_MENTION=true`：群里只有 @ 机器人时才处理；私聊不受此项影响。
- `ALLOWED_CHAT_IDS`：允许使用的群，逗号分隔。
- `ALLOWED_SENDER_IDS`：允许使用的员工，逗号分隔。
- `YOKO_HANDOFF_CHAT_ID`：阻断性问题自动交接群；留空则只创建工单、不发 Yoko 通知。
- `CONTENT_PRODUCER_SOURCE_CHAT_ID`：内容维护制作人来源群；留空则无法自动读取制作人。
- `BRIDGE_DATA_DIR`、`BRIDGE_DB_PATH`、`BRIDGE_RESOURCE_DIR`：SQLite 和附件持久化位置，生产环境应放在持久磁盘并限制目录权限。
- `CODEX_MODEL`、`CODEX_PROFILE`：可选；留空时沿用服务账号的 Codex 默认配置。
- `HEALTH_PORT=0`：关闭健康检查端口；默认只监听 `127.0.0.1:8787/healthz`。

不要提交 `.env`，不要把 App Secret 写进飞书消息或日志。建议通过主机密钥管理器或部署平台的 Secret 注入环境变量。

## 4. 验证与启动

```bash
npm run typecheck
npm test
node --env-file=.env --import tsx src/doctor.ts
npm run build
node --env-file=.env dist/src/main.js
```

`doctor` 会检查 Codex、Meegle 登录、`lark-cli` profile、工作区规则和运行配置。启动日志出现 `service.ready` 后，在允许的群里发送：

```text
@工单机器人 创建一个风控处理工单：
Pisell 订单号：12345
Chargeback 金额：100 AUD
风控来源：人工发现
Chargeback 原因：客户对该笔交易提出拒付
当前处理负责人：Echo
是否查看后台订单：是
后台交易标识：已设置
订单基础判断：订单存在，支付状态正常
风控初步分析：可能是客户不认识账单名称
是否通知商家：否
未通知商家原因：商家失踪
Nick 扣款任务：请检查该订单是否需要扣款
```

预览返回后，直接在同一私聊或群里回复 `仍创建`。更新已有工单时，按机器人提示回复类似 `确认更新 #7127336898`。不要把不同员工共用的确认文本当作跨用户会话；服务已按发送人隔离上下文。

## 5. 常驻运行

开发验证可直接使用上面的 Node 命令。生产环境请交给 systemd、supervisord、容器编排或公司的进程托管平台，并至少配置：

- 工作目录为 `bridge/`；启动命令为 `node --env-file=.env dist/src/main.js`。
- 异常自动重启，但不要删除 SQLite 数据库和资源目录。
- 对 `/healthz` 做本机探活；日志采集时屏蔽密钥环境变量。
- 定期备份 SQLite 与附件目录，并按公司的数据保留策略清理。
- 升级前先停止进程、备份数据、执行 `npm ci && npm run typecheck && npm test && npm run build`，再启动新版本。

## 故障处理

- 收不到消息：检查应用是否已发布、机器人是否在群中、长连接事件是否为 `im.message.receive_v1`，以及群/发送人白名单。
- 能收消息但无法回复：检查机器人发言权限和 `im:message:send_as_bot`。
- 附件下载失败：检查 `im:resource`，并确认附件属于当前消息且未超过 `MAX_RESOURCE_BYTES`。
- `doctor` 中 Meegle 失败：重新完成 `meegle auth login --host project.feishu.cn`。
- 某条消息显示“无法确认是否已经发生外部写入”：先在 Meegle 按订单号或标题查重，再发送一条新的明确指令；不要复制重放原始事件。

## 安全说明

桥接服务会代表已登录的服务账号执行真实 Meegle 写操作。它不会取消插件的授权规则：新建可按工作区持续授权提交，更新已有工单仍需针对具体工单明确确认。建议先在测试群和测试空间完成端到端验证，再把生产群加入白名单。
