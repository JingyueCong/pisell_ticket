import type { IntakeRoutePolicy, PairedWorkItemType } from "./types.js";

const CREATE_INTENT =
  /(?:创建|新建|提交|开)(?:一个|一张|个|张)?(?:[^，。\n]{0,16})?(?:工单|工作项|ticket|阻断性问题|内容维护|需求池|客户刷卡机|风控处理|上门服务)|(?:给我|帮我)?建(?:一个|一张|个|张)?(?:[^，。\n]{0,16})?(?:工单|工作项|单)/iu;
const NON_CREATE_CONTEXT =
  /^(?:请)?(?:帮我)?(?:查询|查看|更新|修改|补充|关联|关闭|取消|删除|解释|检查)|(?:^|[\s：:])(?:为什么|怎么|如何|是否|能否|能不能|可不可以)(?:[^，。\n]{0,20})(?:创建|新建|工单)|(?:已经|已|刚刚|刚才|之前)创建/u;
const STANDALONE_MODIFIER = /(?:单独|独立|仅|只)(?:需要|要|想|给我|帮我)?(?:创建|新建|提交|开|建)/u;

const T1 = /(?:^|[^a-z0-9])t\s*1(?:[^a-z0-9]|$)|核心阻断/u;
const T2 = /(?:^|[^a-z0-9])t\s*2(?:[^a-z0-9]|$)|非核心阻断/u;
const T3 = /(?:^|[^a-z0-9])t\s*3(?:[^a-z0-9]|$)/u;
const T4 = /(?:^|[^a-z0-9])t\s*4(?:[^a-z0-9]|$)/u;
const T5 = /(?:^|[^a-z0-9])t\s*5(?:[^a-z0-9]|$)/u;

const CONTENT_MAINTENANCE = /内容维护|内容制作|内容工单|代制作/u;
const DEMAND_POOL = /需求池|功能建议|功能改进/u;
const CUSTOMER_CARD_MACHINE = /客户刷卡机|刷卡机申请|刷卡机(?:工单|工作项)/u;
const RISK_CONTROL = /风控(?:处理|工单|工作项)?|chargeback|拒付/iu;
const BLOCKING_STANDALONE = /阻断性问题|t\s*-?\s*bug/u;
const CUSTOMER_SERVICE = /客服工单/u;
const CUSTOMER_ONLY = /商务类|内部(?:定期)?跟进|客户情绪|公关危机/u;
const VISIT_RECORD = /上门服务|现场记录|会议记录|录音工单/u;

const OTHER_EXPLICIT_TYPES =
  /开发进度|产品功能|客户管理\s*crm|\bcrm\b|商机跟进|版本迭代|验收记录|预工单|硬件库|组件开发|数据基建/iu;

function standaloneRequested(text: string): boolean {
  return (
    STANDALONE_MODIFIER.test(text) ||
    /(?:不要|无需|不需要)(?:[^，。\n]{0,10})客服工单/u.test(text) ||
    /(?:只|仅)(?:[^，。\n]{0,10})(?:内容维护|内容工单|需求池|客户刷卡机|风控处理|阻断性问题|t\s*-?\s*bug)/iu.test(
      text,
    )
  );
}

function standalonePolicy(
  type: PairedWorkItemType,
  reason: string,
): IntakeRoutePolicy {
  return {
    mode: "standalone",
    authoritative: true,
    standaloneWorkItemType: type,
    reason,
  };
}

function bundlePolicy(
  option: string,
  pairedWorkItemType: PairedWorkItemType,
  reason: string,
): IntakeRoutePolicy {
  return {
    mode: "customer_bundle",
    authoritative: true,
    customerIssueOption: option,
    pairedWorkItemType,
    reason,
  };
}

/**
 * Resolve only high-confidence creation aliases at the bridge boundary.
 *
 * The policy deliberately does not inspect image contents. Images remain evidence
 * for the ticket agent, while the textual creation alias locks whether a customer
 * service main item is mandatory. Follow-up, query, and update messages are left
 * unspecified so an active structured draft can continue normally.
 */
export function deriveIntakeRoutePolicy(content: string): IntakeRoutePolicy {
  const text = content.trim().toLowerCase();
  const hasCreateIntent = CREATE_INTENT.test(text);

  if (!hasCreateIntent || NON_CREATE_CONTEXT.test(text)) {
    return {
      mode: "unspecified",
      authoritative: false,
      reason: "not_a_new_creation_request",
    };
  }

  const explicitStandalone = standaloneRequested(text);

  if (CONTENT_MAINTENANCE.test(text)) {
    return explicitStandalone
      ? standalonePolicy("content_maintenance", "explicit_standalone_content_maintenance")
      : bundlePolicy(
          "T3客户代运营请求-内容维护",
          "content_maintenance",
          "content_maintenance_creation_alias_defaults_to_customer_bundle",
        );
  }
  if (T3.test(text)) {
    return explicitStandalone
      ? standalonePolicy("content_maintenance", "explicit_standalone_t3_target")
      : bundlePolicy(
          "T3客户代运营请求-内容维护",
          "content_maintenance",
          "t3_creation_alias",
        );
  }

  if (T2.test(text)) {
    return explicitStandalone
      ? standalonePolicy("blocking_issue", "explicit_standalone_t2_target")
      : bundlePolicy(
          "T2非核心阻断性问题类流转升级",
          "blocking_issue",
          "t2_creation_alias",
        );
  }
  if (T1.test(text)) {
    return explicitStandalone
      ? standalonePolicy("blocking_issue", "explicit_standalone_t1_target")
      : bundlePolicy("T1核心阻断性问题", "blocking_issue", "t1_creation_alias");
  }
  if (BLOCKING_STANDALONE.test(text)) {
    return standalonePolicy("blocking_issue", "explicit_blocking_issue_type");
  }

  if (T5.test(text) || DEMAND_POOL.test(text)) {
    return explicitStandalone
      ? standalonePolicy("demand_pool", "explicit_standalone_demand_pool")
      : bundlePolicy(
          "T5功能建议/改进类-需求",
          "demand_pool",
          T5.test(text) ? "t5_creation_alias" : "demand_creation_alias_defaults_to_customer_bundle",
        );
  }

  if (CUSTOMER_CARD_MACHINE.test(text)) {
    return explicitStandalone
      ? standalonePolicy("customer_card_machine", "explicit_standalone_customer_card_machine")
      : bundlePolicy(
          "客户刷卡机",
          "customer_card_machine",
          "customer_card_machine_creation_alias_defaults_to_customer_bundle",
        );
  }

  if (RISK_CONTROL.test(text)) {
    return explicitStandalone
      ? standalonePolicy("risk_control", "explicit_standalone_risk_control")
      : bundlePolicy(
          "风控处理",
          "risk_control",
          "risk_control_creation_alias_defaults_to_customer_bundle",
        );
  }

  if (T4.test(text) || CUSTOMER_ONLY.test(text)) {
    return {
      mode: "customer_only",
      authoritative: true,
      ...(T4.test(text) ? { customerIssueOption: "T4流转商务类" } : {}),
      reason: T4.test(text) ? "t4_creation_alias" : "customer_only_issue_alias",
    };
  }

  if (VISIT_RECORD.test(text)) {
    return {
      mode: "customer_only",
      authoritative: true,
      customerIssueOption: "上门服务",
      reason: "visit_record_customer_service_alias",
    };
  }

  if (CUSTOMER_SERVICE.test(text)) {
    return {
      mode: "customer_auto",
      authoritative: true,
      reason: "explicit_customer_service_creation",
    };
  }

  if (!OTHER_EXPLICIT_TYPES.test(text)) {
    return {
      mode: "customer_auto",
      authoritative: true,
      reason: "generic_ticket_creation_defaults_to_customer_service",
    };
  }

  return {
    mode: "unspecified",
    authoritative: false,
    reason: "explicit_non_customer_work_item_type",
  };
}
