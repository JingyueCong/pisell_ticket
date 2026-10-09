export type ExternalWriteState = "none" | "unknown";

export class AgentBackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly externalWriteState: ExternalWriteState,
  ) {
    super(message);
    this.name = "AgentBackendError";
  }
}

export function buildAgentFailureReply(messageId: string, error: unknown): string {
  if (error instanceof AgentBackendError && error.externalWriteState === "none") {
    return [
      "没有创建工单：工单 Agent 运行环境未通过兼容性检查。",
      "本次失败发生在执行工单步骤之前，未对 Meegle 进行外部写入。",
      `消息 ID：${messageId}`,
      "请由管理员修复运行环境并确认健康检查恢复后，再作为一条新消息重新发送。",
    ].join("\n");
  }

  return [
    "这条工单消息处理失败，当前无法确认是否已经发生外部写入。",
    `消息 ID：${messageId}`,
    "为避免重复建单，机器人不会自动重试同一消息；请由管理员先核对 Meegle 后再重新发送。",
  ].join("\n");
}
