# 飞书工单收集器

`lark-ticket-collector` 是一个可安装的 Codex 插件，用于把飞书群聊或私聊中的业务事项自动路由为 Pisell 项目管理工作项。当前功能版本为 `2.3.0`。

它覆盖 Pisell 当前返回的全部 22 个类型：16 个标准创建类型、图表和子任务两个专用域，以及 4 个已停用的历史类型。插件会完成类型识别、创建必填项与隐藏角色补全、同类型查重、简洁预览、工单创建、附件归档、字段回读和当前节点就绪检查；客服工单选择 T1/T2 时会联动阻断性问题，选择 T3 内容维护、T5 需求、客户刷卡机或风控处理时会联动对应业务工作项并验证双向关联。只有实际新建的阻断性问题会按工作区授权进入 Yoko CLI 拆解交接。

## 项目结构

```text
.codex-plugin/plugin.json              # Codex 插件清单
skills/lark-ticket-collector/          # 收单与交接流程
skills/meegle/                         # 自包含的 Meegle CLI 操作技能
workspace/AGENTS.md                    # 可复制到专用收单工作区的业务规则
workspace/configuration/               # 已确认的策略记录
bridge/                                # 飞书内全流程机器人的常驻桥接服务
scripts/check_package.py               # 离线结构与引用检查
tests/test_package.py                  # 配置与快照契约测试
TEST_REPORT.md                         # 最近一次测试结果与外部阻塞项
MANIFEST.txt                           # 发布文件 SHA-256
```

两个 Skill 已放在同一插件内，主 Skill 通过相对链接读取 Meegle 协议，不依赖某位开发者电脑上的绝对路径。

## 运行依赖

- Codex 桌面版或支持插件的 Codex 运行环境。
- `meegle` CLI，并完成目标站点的 OAuth 登录。
- `lark-cli`，并配置可访问目标群、消息和通讯录的 profile。
- 对目标 Meegle 空间、模板、字段和工作项拥有相应权限。

默认业务配置面向 `v2qint` 空间的全部工作项类型。类型、启用状态、目标群、接收人、字段名称和模板版本仍会在执行时核验，不能把快照当作在线真值。完整在线目录保存在 `workspace/configuration/work-item-catalog.json`，创建后就绪状态和风控 Chargeback 首节点 profile 保存在 `workspace/configuration/workflow-readiness.json`；阻断性问题、需求池和客服工单另有已完成真实创建的专项规则。

创建接口返回 ID 不等于工单完整。插件区分 `created`、`create_verified`、`awaiting_node_input`、`ready_for_processing` 和 `workflow_verified`；所有标准类型在创建后都必须检查当前节点未完成必填项。没有业务依据时不会为节点字段编造默认值，也不会把补字段解释为节点流转授权。

官方 Meegle CLI 可通过 `npx -y @lark-project/meegle@1.0.23 install --host project.feishu.cn --device-code --lang zh` 安装并登录。生产使用前不要跳过 OAuth。

## 本地校验

在插件根目录运行：

```bash
python3 scripts/update_manifest.py
python3 scripts/check_package.py
python3 -m unittest discover -s tests -v
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/lark-ticket-collector
python3 /path/to/skill-creator/scripts/quick_validate.py skills/meegle
shasum -a 256 -c MANIFEST.txt
```

`check_package.py` 只做离线检查：JSON、插件清单、Skill 名称、相对 Markdown 引用和机器绑定路径。真实创建工单、上传附件和群通知需要在具备账号权限的环境中单独做冒烟测试。

## 安装与工作区配置

将整个目录作为插件安装或放入已配置的本地插件市场。不要只复制主 Skill，否则 Meegle 协议引用会缺失。

如需启用套件内的专用收单约定，将 `workspace/AGENTS.md` 复制到专用收单工作区根目录，并将 `workspace/configuration/*.json` 复制到该工作区的 `.ticket-collector/configuration/`。这些文件包含面向当前业务的空间和群配置；换团队或环境时必须先审阅并替换。

生产群 ID 不写入 `runtime.json`：Yoko 交接群从 `YOKO_HANDOFF_CHAT_ID` 读取，内容维护制作人来源群从 `CONTENT_PRODUCER_SOURCE_CHAT_ID` 读取。两者为空只会关闭对应自动化。`recipient_member_id` 默认留空；飞书 `open_id` 具有应用作用域，必须由实际发送应用在目标群动态解析 Yoko CLI，禁止保存或复用旧 `open_id`。

## 完全在飞书中使用

`bridge/` 提供可部署的常驻服务：员工只需在飞书私聊机器人，或在已授权群中 @ 机器人；服务会接收文字和附件、调用本插件完成预览/确认/创建/更新，再把结果回复到原消息线程。员工侧不需要打开 Codex 或运行命令。

服务端仍需一台长期在线的 Node.js 22+ 主机，并配置飞书自建应用、Codex、Meegle OAuth 和 `lark-cli`。完整安装、权限和运维说明见 [bridge/README.md](bridge/README.md)。

## 安全边界

- 只负责收单、查重、创建或经授权更新工单、附件归档、流程核验和指定群交接。
- 不读取或修改业务代码，不连接数据库，不查询 Grafana，不执行根因分析、修复、部署或运行时变更。
- 新建工单可以遵循工作区的持续授权自动提交；已有工单更新仍需对具体变更取得明确授权。
- 写操作失败时以回读结果为准，不通过重复创建、跨工单写入或改发评论来掩盖失败。

## 发布说明

修改任意发布文件后，运行 `python3 scripts/update_manifest.py` 重新生成 `MANIFEST.txt`。清单不包含自身、依赖、构建产物、运行数据和本地密钥文件，路径均相对插件根目录。
