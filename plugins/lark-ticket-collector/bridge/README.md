# 飞书工单桥接服务

这个服务把 `lark-ticket-collector` 变成一个员工全程在飞书里使用的机器人。它通过飞书长连接接收群聊或私聊消息，下载随消息发送的附件，调用无界面的 Codex 工单 Agent，并把预览、确认提示或最终工单链接回复到原消息。

员工不需要安装任何东西。服务端需要长期在线；这里的“完全放在飞书上”指交互入口与结果都在飞书内，不代表代码在飞书客户端中运行。

## 已实现的边界

- 支持私聊和群聊 @ 机器人，支持文字、图片和常见消息附件。
- 按 `chat_id + sender_open_id + thread/root message` 隔离上下文；没有回复线程时，只会把最近的未过期草稿作为候选续填上下文。
- 未完成工单会保存结构化草稿（类型、事实摘要、缺失字段、已验证工单号和附件引用），支持下一条消息补字段并继续使用原截图；新工单不会复用旧草稿字段。
- 草稿默认 7 天过期；只向 Codex 提供默认 30 天内最多 12 条相关消息，旧记录不会在升级时被删除。
- 复用插件现有的类型路由、查重、创建/更新授权、附件归档和流程就绪检查。
- SQLite 记录消息状态并按飞书 `message_id` 幂等。同一消息失败后不会自动重放，以免外部写入结果不明时重复建单。
- 附件落盘后记录 SHA-256；附件和截图内容一律按不可信业务证据处理，不能覆盖系统规则。
- 可用群、可用员工、是否必须 @ 机器人都由环境变量限制。
- 可把指定客户群配置为“上门服务会议群”：群内发送一条飞书妙记链接后，无需 @ 机器人，服务会读取智能纪要、章节、待办、关键词和完整逐字稿，并只创建一张“上门服务工单”客服主单。群内其他普通消息仍遵守 `REQUIRE_MENTION`。
- 可启用员工级 Meegle OAuth：每位员工首次使用时绑定自己的身份，之后由该员工身份执行查重、创建、更新、附件和回读，系统“创建人”因此等于飞书消息提交人；禁止回退到 Echo 或其他共用账号。

## 架构

```text
飞书员工
  -> 飞书自建应用机器人（im.message.receive_v1，长连接）
  -> bridge（白名单、员工 OAuth、附件下载、排队、幂等、会话记录）
  -> codex exec（lark-ticket-collector 插件）
  -> Meegle / lark-cli
  -> 回复原飞书消息
```

当前后端使用本机 `codex exec`，因此会直接复用这套插件和工作区规则。`AgentBackend` 已单独抽象，后续如需把运行层替换为 OpenAI Agents SDK，不需要改飞书接入与幂等存储。

## 1. 准备飞书应用

在飞书开放平台创建企业自建应用并启用机器人能力：

1. 在权限管理中至少申请 `im:message`、`im:message:send_as_bot`、`im:resource` 和 `im:chat.members:read`。启用员工级 Meegle OAuth 时，还要让 `LARK_CLI_PROFILE` 的用户授权 `contact:user:search`，用于核对 OAuth 账号确实属于当前消息发送者。启用上门服务会议自动收单时，应用还必须能接收群内非 @ 消息；`LARK_CLI_PROFILE` 对应用户需要授权 `minutes:minutes.basic:read`，并且该账号本身能访问目标妙记。如果机器人只接收群内 @ 消息，可按飞书控制台提示申请对应的群 @ 消息权限；如果要读取群内所有消息，需申请更高范围的群消息权限。
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
# 指定客户群中发送飞书妙记链接时自动创建上门服务客服主单，多个群用逗号分隔。
VISIT_RECORD_CHAT_IDS=oc_customer_a,oc_customer_b
BRIDGE_WORKSPACE=/srv/pisell-ticket-workspace
PER_USER_MEEGLE_AUTH=true
MEEGLE_BIN=/absolute/path/to/meegle
LARK_CLI_BIN=/absolute/path/to/lark-cli
# 可选：把当前员工 open_id 复用到一个已经存在的专属 Meegle profile。
MEEGLE_PROFILE_OVERRIDES=ou_echo=default
```

关键项：

- `REQUIRE_MENTION=true`：群里只有 @ 机器人时才处理；私聊不受此项影响。
- `ALLOWED_CHAT_IDS`：允许使用的群，逗号分隔。
- `ALLOWED_SENDER_IDS`：允许使用的员工，逗号分隔。
- `YOKO_HANDOFF_CHAT_ID`：阻断性问题自动交接群；留空则只创建工单、不发 Yoko 通知。
- `CONTENT_PRODUCER_SOURCE_CHAT_ID`：内容维护制作人来源群；留空则无法自动读取制作人。
- `VISIT_RECORD_CHAT_IDS`：上门服务客户群，逗号分隔。群内出现且仅出现一个飞书妙记链接时自动处理，不需要 @；链接所在群的群名仅用作 CRM 客户检索线索，唯一匹配后才填写客户。单纯上传音频文件或发送普通文本不会自动建单。
- `PER_USER_MEEGLE_AUTH=true`：每位员工首次发消息时收到个人 OAuth 链接；完成后回复“已授权”，验证通过后重新发送原工单和附件。未授权、授权错账号或凭证失效时不会运行 Agent，也不会借用其他人的账号。
- `MEEGLE_PROFILE_OVERRIDES`：可选的 `sender_open_id=meegle_profile` 映射，逗号分隔，仅用于复用已经存在且属于该员工自己的 profile。没有映射的员工自动使用由 open_id 单向派生的独立 profile。
- `LARK_CLI_BIN`、`MEEGLE_BIN`：后台服务使用的绝对 CLI 路径，避免 launchd 等无交互环境的 PATH 不完整。
- `BRIDGE_DATA_DIR`、`BRIDGE_DB_PATH`、`BRIDGE_RESOURCE_DIR`：SQLite 和附件持久化位置，生产环境应放在持久磁盘并限制目录权限。
- `CODEX_MODEL`、`CODEX_PROFILE`：可选；留空时沿用服务账号的 Codex 默认配置。
- `MAX_HISTORY_MESSAGES`：每轮提供给 Agent 的最近消息数，默认 12；这是消息数，不是工单数。
- `MAX_HISTORY_AGE_DAYS`：超过该时间的历史不再进入模型上下文，默认 30 天；不会删除 SQLite 原始记录。
- `DRAFT_TTL_HOURS`：未完成结构化草稿的有效期，默认 168 小时（7 天）。过期草稿不会继续补填。
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

启用员工级 OAuth 时，`doctor` 不要求默认 Meegle profile 已登录，而是检查 CLI 可执行文件，并使用 override 中第一位员工验证 `contact:user:search` 权限。首次收单的授权过程不会保存 access token 到 bridge 数据库；token 仍由 Meegle CLI 自己管理，bridge 只保存发送者与已验证 profile/user_key 的绑定。

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

预览返回后，优先回复原消息或在同一线程中发送 `仍创建`。直接发送下一条消息时，服务也会把该员工最近的未过期草稿作为候选，但如果要新建另一张工单，请明确写“创建一个新的……工单”。更新已有工单时，按机器人提示回复类似 `确认更新 #7127336898`。不同员工、不同线程和不同新工单之间不会共用草稿字段。

结构化草稿只是续填上下文，不是 Meegle 的权威状态。每次外部写入仍会实时查重、刷新字段元数据并回读验证；草稿不会绕过更新确认或附件要求。

### 上门服务会议自动收单

先在客服工单的“对应问题类型”字段中新增并启用选项 `上门服务工单`。随后把客户群加入 `VISIT_RECORD_CHAT_IDS`。会议结束且飞书妙记已生成后，在该客户群发送妙记链接即可自动触发：

```text
https://tenant.feishu.cn/minutes/obcnu...
```

服务会读取群名作为客户线索，读取妙记智能总结与完整逐字稿，并整理现场背景、全部问题、影响、客户期望、客户提出的办法、会议确认方案、未确认项、行动项、负责人和时间。当前阶段只创建一张客服主单，不会从纪要直接拆出 T1/T2/T3/T5 等配套工单；原始妙记链接会保留在问题描述中，方便后续人工或自动拆票。

自动触发依赖“妙记链接被发送到目标群”，不是监听录音停止事件。飞书的妙记生成事件不包含来源客户群，单靠该事件无法可靠判断客户；以链接所在群为客户上下文可避免跨群串单。若妙记尚未生成、未共享给读取账号、权限不足、消息含多个妙记链接或 CRM 客户无法唯一匹配，服务不会猜测或先建半张单，而会在原消息下提示补充。

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
- 上门服务链接没有触发：确认群 ID 在 `VISIT_RECORD_CHAT_IDS`，应用能接收该群的非 @ 消息，机器人仍在群内，并且消息中是可识别的 `/minutes/<token>` 链接。
- 上门服务提示妙记不可读：确认 `LARK_CLI_PROFILE` 的用户已授权 `minutes:minutes.basic:read`，该用户能在飞书中打开该妙记，而且妙记已经生成完成。
- 上门服务卡在字段：确认客服工单“对应问题类型”已有启用选项 `上门服务工单`；bridge 不会用其他问题类型代替。
- `doctor` 中 Meegle 失败：确认 `MEEGLE_BIN` 路径正确；未启用员工 OAuth 时重新完成 `meegle auth login --host project.feishu.cn`。
- 首次使用一直提示未授权：先打开机器人返回的个人授权链接完成登录，再回复“已授权”；授权链接过期后重新发送工单取得新链接。
- 身份验证失败：确认 `LARK_CLI_PROFILE` 已授权 `contact:user:search`，且员工在 OAuth 页面登录的是自己的飞书项目账号。
- 某条消息显示“无法确认是否已经发生外部写入”：先在 Meegle 按订单号或标题查重，再发送一条新的明确指令；不要复制重放原始事件。

## 安全说明

未启用员工 OAuth 时，桥接服务会代表已登录的服务账号执行真实 Meegle 写操作；启用后则只使用当前消息发送者已验证的独立 profile。两种模式都不会取消插件的授权规则：新建可按工作区持续授权提交，更新已有工单仍需针对具体工单明确确认。建议先在测试群和测试空间完成端到端验证，再把生产群加入白名单。
