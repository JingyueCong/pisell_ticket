import type {
  AgentResult,
  CustomerCrmCandidate,
  DraftSnapshot,
  InboundEnvelope,
  StoredMessage,
} from "./types.js";

const API_FAILURE_CLAIM =
  /(?:接口|API|元数据|配置)(?:[^。；\n]{0,30})(?:拒绝|报错|失败|异常|不可用|恢复)|等待接口|接口配置恢复/iu;
const CREATE_REJECTION_CLAIM = /(?:提交|创建)(?:[^。；\n]{0,16})(?:接口|API)(?:[^。；\n]{0,20})(?:拒绝|失败|报错)/iu;
const CUSTOMER_DRAFT = /客服工单|customer[_ -]?service/iu;
const ISSUE_TYPE = /对应问题类型|field_5e764e|问题类型/iu;
const PROBLEM_SOURCE = /问题来源|field_20a3c6/iu;
const MERCHANT_REPORTER = /商家问题提出人|field_91fbb2/iu;
const CUSTOMER = /客户管理|客户\/店铺|客户或店铺|CRM/iu;
const NAME = /(?:^|[：:\s])名称(?:$|[：:\s])|工单名称/iu;
const DESCRIPTION = /问题描述|任务描述|(?:^|[：:\s])描述(?:$|[：:\s])/iu;
const KNOWN_PROBLEM_SOURCE =
  /企业微信|企微|WhatsApp|客服(?:专用)?邮箱|飞书商家群|Zendesk|线下销售\s*[/／]\s*运营转述|线下销售|运营转述/iu;
const KNOWN_ISSUE_TYPE =
  /T\s*[1-5]|核心阻断|非核心阻断|内容维护|客户代运营|商务类|功能建议|需求|内部跟进|客户情绪|公关|客户刷卡机|风控处理|上门服务/iu;

export interface OutcomeGuardResult {
  result: AgentResult;
  corrected: boolean;
  reason?: "missing_fields" | "unsupported_api_failure_claim";
}

function canonicalMissingFields(values: string[]): string[] {
  const output: string[] = [];
  const add = (value: string): void => {
    if (!output.includes(value)) output.push(value);
  };
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    let recognized = false;
    if (PROBLEM_SOURCE.test(value)) {
      add("问题来源");
      recognized = true;
    }
    if (ISSUE_TYPE.test(value)) {
      add("对应问题类型");
      recognized = true;
    }
    if (MERCHANT_REPORTER.test(value)) {
      add("商家问题提出人");
      recognized = true;
    }
    if (CUSTOMER.test(value)) {
      add("客户/店铺");
      recognized = true;
    }
    if (NAME.test(value)) {
      add("工单名称");
      recognized = true;
    }
    if (DESCRIPTION.test(value)) {
      add("问题描述");
      recognized = true;
    }
    if (!recognized && !/(?:接口|API|配置|元数据)/iu.test(value)) add(value);
  }
  return output;
}

function isCustomerDraft(input: {
  envelope: InboundEnvelope;
  activeDraft?: DraftSnapshot;
  result: AgentResult;
}): boolean {
  return (
    ["customer_bundle", "customer_only", "customer_auto"].includes(
      input.envelope.routePolicy?.mode ?? "",
    ) ||
    CUSTOMER_DRAFT.test(
      [
        input.activeDraft?.ticketType,
        input.activeDraft?.summary,
        input.result.draft.ticketType,
        input.result.draft.summary,
      ]
        .filter(Boolean)
        .join(" "),
    )
  );
}

function issueTypeResolved(input: {
  envelope: InboundEnvelope;
  activeDraft?: DraftSnapshot;
  result: AgentResult;
}): boolean {
  if (input.envelope.routePolicy?.customerIssueOption) return true;
  return KNOWN_ISSUE_TYPE.test(
    [
      input.activeDraft?.ticketType,
      input.activeDraft?.summary,
      input.result.draft.ticketType,
      input.result.draft.summary,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function userEvidence(input: {
  envelope: InboundEnvelope;
  history: StoredMessage[];
  activeDraft?: DraftSnapshot;
  result: AgentResult;
}): string {
  return [
    input.envelope.content,
    ...input.history.filter((message) => message.role === "user").map((message) => message.content),
    input.activeDraft?.summary,
    input.result.draft.summary,
  ]
    .filter(Boolean)
    .join("\n");
}

function clarificationLine(field: string): string {
  if (field === "问题来源") {
    return "问题来源：企业微信、WhatsApp、客服邮箱、飞书商家群、Zendesk，还是线下销售/运营转述？";
  }
  if (field === "对应问题类型") {
    return "对应问题类型：属于 T1/T2 阻断、T3 内容维护、T4 商务、T5 功能建议/需求，还是其他客服类型？";
  }
  if (field === "商家问题提出人") return "商家问题提出人：请提供姓名或可识别称呼。";
  if (field === "客户/店铺") return "客户/店铺：请提供客户名称、店铺名称或店铺 ID。";
  return `${field}：请补充该信息。`;
}

function candidateSelectionText(candidates: CustomerCrmCandidate[]): string[] {
  return [
    "客户/店铺：CRM 找到多个候选，请选择一个：",
    ...candidates.map(
      (candidate, index) =>
        `${index + 1}. ${candidate.name}（CRM #${candidate.workItemId}）`,
    ),
    "可回复“第一个/第二个”、候选名称中的区别词，或 CRM ID。",
  ];
}

function clarificationText(
  fields: string[],
  customerCandidates: CustomerCrmCandidate[] = [],
): string {
  const hasAmbiguousCustomer =
    fields.includes("客户/店铺") && customerCandidates.length > 1;
  if (fields.length === 1) {
    if (hasAmbiguousCustomer) {
      return [
        "当前草稿尚未提交，已保留已有文字和附件。",
        ...candidateSelectionText(customerCandidates),
        "选择后会继续处理当前草稿，不会从头重复建单。",
      ].join("\n\n");
    }
    return [
      "当前草稿尚未提交，已保留已有文字和附件。",
      `请补充${clarificationLine(fields[0]!)}`,
      "补充后会继续处理当前草稿，不会从头重复建单。",
    ].join("\n\n");
  }
  return [
    "当前草稿尚未提交，已保留已有文字和附件。",
    "请一次性补充以下信息：",
    ...fields.flatMap((field) =>
      field === "客户/店铺" && hasAmbiguousCustomer
        ? candidateSelectionText(customerCandidates).map((line, index) =>
            index === 0 ? `- ${line}` : `  ${line}`,
          )
        : [`- ${clarificationLine(field)}`],
    ),
    "补充后会继续处理当前草稿，不会从头重复建单。",
  ].join("\n");
}

export function enforceDeterministicOutcome(input: {
  envelope: InboundEnvelope;
  history: StoredMessage[];
  activeDraft?: DraftSnapshot;
  customerCandidates?: CustomerCrmCandidate[];
  selectedCustomerCandidate?: CustomerCrmCandidate;
  result: AgentResult;
}): OutcomeGuardResult {
  const committed = input.result.workItemOutcomes.some(
    (outcome) => outcome.disposition !== "queried",
  );
  if (committed || !["open", "update"].includes(input.result.draft.action)) {
    return { result: input.result, corrected: false };
  }

  let missingFields = canonicalMissingFields(input.result.draft.missingFields);
  if (input.selectedCustomerCandidate) {
    missingFields = missingFields.filter((field) => field !== "客户/店铺");
  }
  const customerDraft = isCustomerDraft(input);
  const evidence = userEvidence(input);
  if (customerDraft && !KNOWN_PROBLEM_SOURCE.test(evidence)) {
    if (!missingFields.includes("问题来源")) missingFields.push("问题来源");
  }
  if (customerDraft && issueTypeResolved(input)) {
    missingFields = missingFields.filter((field) => field !== "对应问题类型");
  } else if (customerDraft && !KNOWN_ISSUE_TYPE.test(evidence)) {
    if (!missingFields.includes("对应问题类型")) missingFields.push("对应问题类型");
  }

  if (missingFields.length > 0) {
    const text = clarificationText(missingFields, input.customerCandidates);
    return {
      result: {
        ...input.result,
        text,
        draft: { ...input.result.draft, missingFields },
      },
      corrected:
        input.result.text !== text ||
        JSON.stringify(input.result.draft.missingFields) !== JSON.stringify(missingFields),
      reason: "missing_fields",
    };
  }

  const verifiedCommandFailures = (input.result.commandEvidence ?? []).filter(
    (entry) => entry.exitCode !== 0 && !entry.policyDenied,
  );
  const verifiedWriteFailure = verifiedCommandFailures.some((entry) =>
    /^(?:workitem (?:create|update)|workflow (?:update|update-node|transition))/iu.test(
      entry.operation,
    ),
  );
  const unsupportedFailureClaim =
    API_FAILURE_CLAIM.test(input.result.text) &&
    (CREATE_REJECTION_CLAIM.test(input.result.text)
      ? !verifiedWriteFailure
      : verifiedCommandFailures.length === 0);
  if (unsupportedFailureClaim) {
    return {
      result: {
        ...input.result,
        text: [
          "本轮没有创建工单，也没有检测到可核验的 Meegle 接口错误。",
          "系统已保留当前草稿；请回复“继续提交”，系统会重新执行字段校验和创建。",
        ].join("\n\n"),
      },
      corrected: true,
      reason: "unsupported_api_failure_claim",
    };
  }
  return { result: input.result, corrected: false };
}
