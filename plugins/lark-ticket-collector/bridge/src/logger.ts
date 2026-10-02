type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const output = JSON.stringify(line);
  if (level === "error") {
    process.stderr.write(`${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

export const logger = {
  info(event: string, fields: Record<string, unknown> = {}) {
    write("info", event, fields);
  },
  warn(event: string, fields: Record<string, unknown> = {}) {
    write("warn", event, fields);
  },
  error(event: string, fields: Record<string, unknown> = {}) {
    write("error", event, fields);
  },
};
