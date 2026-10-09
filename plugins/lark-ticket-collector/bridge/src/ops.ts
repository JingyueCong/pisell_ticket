import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";

process.umask(0o077);

const config = loadConfig();
const store = new BridgeStore(config.storage.dbPath);
const [command = "summary", messageId, ...noteParts] = process.argv.slice(2);

try {
  if (command === "summary") {
    console.log(JSON.stringify(store.operationalSummary(), null, 2));
  } else if (command === "show" && messageId) {
    console.log(JSON.stringify(store.messageAudit(messageId), null, 2));
  } else if (command === "review" && messageId && noteParts.length) {
    store.recordOperation({
      messageId,
      step: "admin_review",
      status: "info",
      detail: { note: noteParts.join(" ").slice(0, 1_000) },
    });
    console.log(JSON.stringify({ ok: true, messageId }, null, 2));
  } else {
    throw new Error("Usage: npm run ops -- summary | show <message-id> | review <message-id> <note>");
  }
} finally {
  store.close();
}
