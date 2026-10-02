# 创建后的流程就绪检查

适用于 Pisell 的所有标准创建类型。机器可读策略和已验证模板 profile 见 [workflow-readiness.json](../../../workspace/configuration/workflow-readiness.json)。在线流程可能变化；配置用于定位和回归测试，当前节点与未完成必填项必须实时回读。

## 为什么创建成功不等于工单完整

Meegle 将信息分成三层：创建表单字段、角色，以及工作流节点表单。`meta-create-fields` 只覆盖第一层的一部分；必填角色可能直到创建接口返回 `ErrFieldRequired` 才暴露，节点必填项通常在实例进入首节点后才可通过工作流接口确认。因此不能把 `workitem create` 返回 ID 当作完整成功。

## 结果状态

- `created`：创建接口返回 ID，尚未回读。
- `create_verified`：回读确认名称、类型、模板版本和本次写入字段。
- `awaiting_node_input`：创建字段已验证，但当前节点仍有未完成必填项。
- `ready_for_processing`：创建字段已验证，所有当前进行中节点的未完成必填列表为空。
- `workflow_verified`：在用户明确授权下完成节点更新或流转，并已回读。

最终回复必须使用实际状态。`awaiting_node_input` 只能说“已创建，待补充”，不能说“完整创建”“已可处理”或“端到端通过”。

## 每张标准工单的强制检查

1. 创建后用 `workitem get` 回读实例和本次写入字段，包括 `template_version`。
2. 用 `workflow get-node` 找出所有 `status=doing` 的当前节点，不假定只有一个。
3. 对每个当前节点调用 `workflow list-state-required --mode unfinished`。
4. 未完成列表为空时标记 `ready_for_processing`；否则标记 `awaiting_node_input`，一次性列出字段、类型和合法选项。
5. 将 `form_item_type=field` 的值经 `workitem update` 写入；`form_item_type=node_field` 经 `workflow update-node` 写入；角色经 `role_operate` 写入。写前刷新对应元数据，写后再次执行第 1 至 4 步。
6. 补字段不等于授权流转。除非用户明确要求完成、确认、回滚或推进节点，否则不得调用 `workflow transition`。

## 值与授权边界

节点必填值往往代表已完成的业务动作，例如“是否已查看后台订单”“是否已通知商家”或分析结论。没有用户事实依据时必须询问，不能用 `false`、`自动生成`、第一枚举项或样例工单值补空。

如果员工在最初消息中已经提供了这些值，且预览明确列出将写入当前新工单，则新建自动提交授权可覆盖创建后的初始节点补全；如果工单已经创建后才获得新值，按已有工单更新处理，展示具体变更并取得确认。上传过但尚未绑定的附件 token 只能复用于同一草稿；不得为了重试重复上传或绑定到另一工单。

## 隐藏角色

模板 profile 已记录的隐藏必填角色必须在创建预览前处理。人员只能按用户明确提供的姓名/邮箱解析；“我负责”才能解析为当前登录用户。同名或无法唯一匹配时必须消歧。

创建接口新返回 `ErrFieldRequired` 时，先确认没有生成工作项，再从错误中的角色名/key 查询 `meta-roles`，将其作为本次草稿的待补项。该发现只有经回读验证并更新配置后才能成为后续规则，不能从一个类型推广到其他类型。

## 风控 Chargeback 已知首节点

`Chargeback 处理流程` 已验证创建时要求“当前处理的负责人”。创建后首节点“问题分析”要求：是否已查看后台订单情况、后台交易标识是否设置、订单基础判断、风控初步分析、是否已通知商家、nick 扣款任务描述。所有字段都是业务事实，不设默认值；实时字段和枚举仍须在线刷新。
