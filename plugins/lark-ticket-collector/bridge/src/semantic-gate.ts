import type { VisualSemanticEvidence } from "./types.js";

interface CriticalPair {
  left: string;
  right: string;
  label: string;
}

const CRITICAL_PAIRS: CriticalPair[] = [
  { left: "线上", right: "线下", label: "渠道" },
  { left: "开启", right: "关闭", label: "开关状态" },
  { left: "打开", right: "关闭", label: "开关动作" },
  { left: "上架", right: "下架", label: "上下架状态" },
  { left: "增加", right: "删除", label: "增删动作" },
  { left: "添加", right: "删除", label: "增删动作" },
  { left: "启用", right: "停用", label: "启停状态" },
  { left: "成功", right: "失败", label: "结果状态" },
  { left: "可以", right: "不可以", label: "许可状态" },
  { left: "需要", right: "不需要", label: "必要性" },
  { left: "订票", right: "订单", label: "业务对象" },
];

export interface SemanticConflict {
  label: string;
  evidenceTerm: string;
  proposedTerm: string;
}

function pairSide(text: string, pair: CriticalPair): "left" | "right" | undefined {
  // Check the longer token first so “不需要” is not also classified as “需要”.
  const ordered = [
    { side: "left" as const, token: pair.left },
    { side: "right" as const, token: pair.right },
  ].sort((first, second) => second.token.length - first.token.length);
  const found = ordered.filter(({ token }, index) => {
    if (!text.includes(token)) return false;
    const longer = ordered[index === 0 ? 1 : 0];
    return !longer || !longer.token.includes(token) || !text.includes(longer.token);
  });
  if (found.length !== 1) return undefined;
  return found[0]?.side;
}

function optionValue(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === option && args[index + 1]) values.push(args[index + 1]!);
    if (argument.startsWith(`${option}=`)) values.push(argument.slice(option.length + 1));
  }
  return values;
}

function collectSemanticJson(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSemanticJson(item, output);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (["name", "title", "description"].includes(key) && typeof item === "string") {
      output.push(item);
      continue;
    }
    if (
      key === "field_value" &&
      typeof item === "string" &&
      typeof record.field_key === "string" &&
      /^(?:name|title|description)$/i.test(record.field_key)
    ) {
      output.push(item);
      continue;
    }
    collectSemanticJson(item, output);
  }
}

function parseSemanticJson(raw: string, output: string[]): void {
  try {
    collectSemanticJson(JSON.parse(raw), output);
  } catch {
    // Invalid JSON will be handled by the Meegle CLI. Do not widen the gate to
    // unrelated arguments because enum labels may legitimately contain an
    // opposite word (for example “线下销售 / 运营转述”).
  }
}

/** Extract only user-visible title/description writes from a Meegle command. */
export function semanticWriteText(args: string[]): string {
  if (args[0] !== "workitem" || !["create", "update"].includes(args[1] ?? "")) {
    return "";
  }
  const values = [
    ...optionValue(args, "--name"),
    ...optionValue(args, "--title"),
    ...optionValue(args, "--description"),
  ];
  for (const raw of [...optionValue(args, "--fields"), ...optionValue(args, "--params")]) {
    parseSemanticJson(raw, values);
  }
  return values.join("\n");
}

export function semanticConflicts(input: {
  evidence: VisualSemanticEvidence;
  proposedText: string;
}): SemanticConflict[] {
  if (!input.proposedText.trim()) return [];
  const evidenceText = input.evidence.quotes.join("\n");
  const conflicts: SemanticConflict[] = [];
  for (const pair of CRITICAL_PAIRS) {
    const evidenceSide = pairSide(evidenceText, pair);
    const proposedSide = pairSide(input.proposedText, pair);
    if (!evidenceSide || !proposedSide || evidenceSide === proposedSide) continue;
    conflicts.push({
      label: pair.label,
      evidenceTerm: evidenceSide === "left" ? pair.left : pair.right,
      proposedTerm: proposedSide === "left" ? pair.left : pair.right,
    });
  }
  return conflicts;
}

export function semanticWritePolicyError(
  args: string[],
  evidence?: VisualSemanticEvidence,
): string | undefined {
  if (!evidence?.quotes.length) return undefined;
  const proposedText = semanticWriteText(args);
  const conflicts = semanticConflicts({ evidence, proposedText });
  if (!conflicts.length) return undefined;
  const detail = conflicts
    .map(
      (conflict) =>
        `${conflict.label}: 原图“${conflict.evidenceTerm}”与拟写“${conflict.proposedTerm}”冲突`,
    )
    .join("；");
  return [
    `Semantic safety gate rejected this write: ${detail}.`,
    "Use the isolated visual quote exactly, rebuild the title/description, and retry automatically.",
    "Do not ask the employee unless the isolated quote itself is ambiguous.",
  ].join(" ");
}
