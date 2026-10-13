import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import {
  isMeegleAuthorizationConfirmation,
  MeegleIdentityManager,
  type ProcessRunner,
} from "../src/meegle-identity.js";

function config(dataDir: string): BridgeConfig {
  return {
    lark: {
      appId: "cli_test",
      appSecret: "secret",
      cliProfile: "lark-admin",
      cliBin: "lark-cli",
      allowedChatIds: [],
      visitRecordChatIds: [],
      visitRecordAllGroups: false,
      allowedSenderIds: [],
      requireMention: true,
      opsAlertCooldownMs: 300_000,
    },
    meegleIdentity: {
      enabled: true,
      bin: "meegle",
      host: "project.feishu.cn",
      projectKey: "v2qint",
      profileOverrides: new Map(),
    },
    codex: {
      bin: "codex",
      workspace: "/tmp/workspace",
      timeoutMs: 180_000,
      probeTimeoutMs: 30_000,
      probeIntervalMs: 1_800_000,
      probeFailureThreshold: 2,
      maxConcurrentRuns: 2,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, "bridge.sqlite"),
      resourceDir: join(dataDir, "resources"),
    },
    limits: {
      maxReplyChars: 12_000,
      maxHistoryMessages: 12,
      maxHistoryAgeMs: 30 * 24 * 60 * 60_000,
      draftTtlMs: 7 * 24 * 60 * 60_000,
      maxResourceBytes: 25 * 1024 * 1024,
    },
    health: { host: "127.0.0.1", port: 0 },
    internalApi: { enabled: false },
    maintenance: {
      resourceRetentionMs: 30 * 24 * 60 * 60_000,
      auditRetentionMs: 180 * 24 * 60 * 60_000,
      intervalMs: 60 * 60_000,
    },
  };
}

test("recognizes only explicit Meegle authorization confirmations", () => {
  assert.equal(isMeegleAuthorizationConfirmation("@机器人 已授权"), true);
  assert.equal(isMeegleAuthorizationConfirmation("授权完成"), true);
  assert.equal(isMeegleAuthorizationConfirmation("请帮我创建工单"), false);
});

test("customer CRM lookup is read-only and uses the verified identity profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        rows: [
          {
            work_item_id: "123456789",
            name: "汪汪咖啡店",
            work_item_status: "跟进中",
          },
        ],
      }),
      stderr: "",
    };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveCustomerCrm({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        merchantName: "汪汪咖啡店",
      });
    assert.equal(result.status, "unique");
    assert.equal(result.readOnly, true);
    assert.equal(result.candidates[0]?.workItemId, "123456789");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[calls[0].indexOf("--profile") + 1], "lark-alice");
    assert.ok(calls[0]?.includes("query"));
    assert.match(
      calls[0]?.[calls[0].indexOf("--mql") + 1] ?? "",
      /67df84a32e42950cb0195cba/u,
    );
    assert.ok(!calls[0]?.some((value) => /create|update|delete/u.test(value)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer CRM lookup reads selected values from nested MQL fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        list: [
          {
            group_infos: [
              {
                data: [
                  {
                    work_item_id: "7128603670",
                    fields: [
                      {
                        field_key: "name",
                        field_name: "店铺id 客户名称",
                        field_value: "新东方鲜生",
                      },
                      {
                        field_key: "work_item_status",
                        field_name: "状态",
                        field_value: "开始",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
    stderr: "",
  });

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveCustomerCrm({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        merchantName: "新东方鲜生",
        lookupHint: "7128603670",
      });
    assert.equal(result.status, "unique");
    assert.deepEqual(result.candidates[0], {
      workItemId: "7128603670",
      name: "新东方鲜生",
      status: "开始",
      url: "https://project.feishu.cn/v2qint/crm/detail/7128603670",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer CRM lookup reads the CLI moql field list row shape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        "1": [
          {
            moql_field_list: [
              {
                key: "work_item_id",
                name: "work_item_id",
                value: {
                  long_value: "7128603670",
                },
                value_type: "long",
              },
              {
                key: "name",
                name: "店铺id 客户名称",
                value: {
                  string_value: "新东方鲜生",
                },
                value_type: "string",
              },
            ],
          },
        ],
      },
    }),
    stderr: "",
  });

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveCustomerCrm({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        merchantName: "新东方鲜生",
        lookupHint: "7128603670",
      });
    assert.equal(result.status, "unique");
    assert.equal(result.matchMethod, "work_item_id");
    assert.deepEqual(result.candidates[0], {
      workItemId: "7128603670",
      name: "新东方鲜生",
      url: "https://project.feishu.cn/v2qint/crm/detail/7128603670",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer CRM lookup does not treat an unrelated nested user name as the customer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      data: {
        rows: [
          {
            work_item_id: "7128603670",
            fields: [
              {
                field_key: "owner",
                field_name: "负责人",
                field_value: [{ user_key: "user_echo", name: "Echo" }],
              },
            ],
          },
        ],
      },
    }),
    stderr: "",
  });

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveCustomerCrm({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        merchantName: "新东方鲜生",
        lookupHint: "7128603670",
      });
    assert.equal(result.status, "not_found");
    assert.deepEqual(result.candidates, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("title updates write only the name field and require a matching readback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  let readCount = 0;
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("get")) {
      readCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          work_item_id: "7132695930",
          name:
            readCount === 1
              ? "旧标题"
              : "新版 POS 无法打印小票",
          work_item_type_key: "6886d47112cff2ae4ae279e3",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({ data: {} }), stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(
      config(directory),
      runner,
      async () => undefined,
    ).renameWorkItemTitle({
      identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
      workItemId: "7132695930",
      newTitle: "新版 POS 无法打印小票",
    });
    assert.equal(result.previousName, "旧标题");
    assert.equal(result.name, "新版 POS 无法打印小票");
    assert.equal(result.changed, true);
    assert.equal(calls.length, 3);
    const update = calls.find((call) => call.includes("update"));
    assert.ok(update);
    assert.equal(update[update.indexOf("--profile") + 1], "lark-alice");
    assert.deepEqual(JSON.parse(update[update.indexOf("--fields") + 1]!), [
      { field_key: "name", field_value: "新版 POS 无法打印小票" },
    ]);
    assert.ok(!update.some((value) => /create|role_operate|node/i.test(value)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a related title target is selected by its verified work item type", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async (_executable, args) => {
    const id = args[args.indexOf("--work-item-id") + 1];
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        work_item_id: id,
        name: id === "7132695930" ? "客服标题" : "阻断标题",
        work_item_type: {
          id:
            id === "7132695930"
              ? "6886d47112cff2ae4ae279e3"
              : "67df88cf656f61b9b41455d3",
          name: id === "7132695930" ? "客服工单" : "阻断性问题",
        },
      }),
      stderr: "",
    };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveWorkItemTitleTarget({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        candidateWorkItemIds: ["7132695930", "7132856228"],
        targetType: "blocking_issue",
      });
    assert.deepEqual(result.map((item) => item.workItemId), ["7132856228"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer CRM candidates can be read back by their stored IDs without writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  const names = new Map([
    ["6416657899", "8793 🌺Basic + sexycloakroom（AU）"],
    ["6168016739", "8793 SexyCloakRoomSYD"],
  ]);
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    const mql = args[args.indexOf("--mql") + 1] ?? "";
    const workItemId = [...names.keys()].find((id) => mql.includes(id));
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        rows: workItemId
          ? [{ work_item_id: workItemId, name: names.get(workItemId) }]
          : [],
      }),
      stderr: "",
    };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .resolveCustomerCrmCandidatesByIds({
        identity: { profile: "lark-yvonne", userKey: "yvonne", name: "Yvonne" },
        workItemIds: ["6416657899", "6168016739", "not-an-id", "6416657899"],
      });
    assert.deepEqual(
      result.map((candidate) => [candidate.workItemId, candidate.name]),
      [...names.entries()],
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call[call.indexOf("--profile") + 1] === "lark-yvonne"));
    assert.ok(calls.every((call) => !call.some((value) => /create|update|delete/u.test(value))));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake node owner is force-updated and read back with the verified profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  let updated = false;
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                node_key: "started-instance",
                form_items: [
                  {
                    field_key: "owner",
                    field_value: updated
                      ? [
                          {
                            user_key: "meegle_alice",
                            name: "Alice",
                            email: "alice@pisell.example",
                            avatar_url: "https://example.invalid/alice.png",
                          },
                        ]
                      : [
                          { user_key: "echo", name: "Echo" },
                          { user_key: "default-owner", name: "Default Owner" },
                        ],
                  },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updated = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: {
          profile: "lark-alice",
          userKey: "meegle_alice",
          name: "Alice",
        },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    const updateCall = calls.find((call) => call.includes("update-node"));
    assert.ok(updateCall);
    assert.equal(updateCall?.[updateCall.indexOf("--profile") + 1], "lark-alice");
    const updateParams = JSON.parse(updateCall?.[updateCall.indexOf("--params") + 1] ?? "{}") as {
      project_key?: string;
      node_id?: string;
      node_owners?: string[];
    };
    assert.equal(updateParams.project_key, "v2qint");
    assert.equal(updateParams.node_id, "started");
    assert.deepEqual(updateParams.node_owners, ["meegle_alice"]);
    assert.ok(calls.every((call) => !call.includes("--node-owners")));
    assert.ok(calls.filter((call) => call.includes("get-node")).every(
      (call) => call[call.indexOf("--field-key-list") + 1] === "_all",
    ));
    assert.equal(calls.filter((call) => call.includes("get-node")).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner verification ignores unrelated nested owner fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updated = false;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                metadata: { owner: { user_key: "template-owner" } },
                form_items: [
                  {
                    field_key: "owner",
                    field_value: [{ user_key: updated ? "meegle_alice" : "echo" }],
                  },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updated = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner verification skips mutation when the owner is already correct", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updateCalls = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("update-node")) updateCalls += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          nodes: [
            {
              name: "创建工单",
              state_key: "started",
              form_items: [
                { field_key: "owner", field_value: [{ user_key: "meegle_alice" }] },
              ],
            },
          ],
        },
      }),
      stderr: "",
    };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    assert.equal(updateCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner update surfaces API errors returned with exit code zero", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                form_items: [{ field_key: "owner", field_value: [{ user_key: "echo" }] }],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        data: null,
        error: { code: "PERMISSION_DENIED", message: "node owner is not editable" },
      }),
      stderr: "",
    };
  };

  try {
    await assert.rejects(
      new MeegleIdentityManager(config(directory), runner)
        .ensureCustomerIntakeNodeOwner({
          identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
          workItemId: "7130051159",
        }),
      /PERMISSION_DENIED: node owner is not editable/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner readback retries brief API propagation lag", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updated = false;
  let readsAfterUpdate = 0;
  let pauses = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("get-node")) {
      if (updated) readsAfterUpdate += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                form_items: [
                  {
                    field_key: "owner",
                    field_value: [
                      { user_key: updated && readsAfterUpdate >= 3 ? "meegle_alice" : "echo" },
                    ],
                  },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updated = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(
      config(directory),
      runner,
      async () => { pauses += 1; },
    ).ensureCustomerIntakeNodeOwner({
      identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
      workItemId: "7130051159",
    });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    assert.equal(readsAfterUpdate, 3);
    assert.equal(pauses, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner accepts localized generic node fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updateCalls = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                form_items: [
                  {
                    field_key: "field_owner_01",
                    field_name: "负责人",
                    field_value: [{ user_key: "meegle_alice", name: "Alice" }],
                  },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updateCalls += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    assert.equal(updateCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("customer intake owner falls back to the canonical MQL node owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updateCalls = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { nodes: [{ name: "创建工单", state_key: "started" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("query")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            rows: [
              {
                work_item_id: "7130051159",
                "get_node_attribute('创建工单','负责人')": [
                  { user_key: "meegle_alice", name: "Alice" },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updateCalls += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    assert.equal(updateCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content producer is reduced to the one round-robin assignee and read back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  let corrected = false;
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("meta-roles")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            roles: [
              { role_id: "role_c17278", role_name: "制作人&交付人" },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("search")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { users: [{ user_key: "user_annie", name: "Annie" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("query")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            rows: [
              {
                work_item_id: "7132735915",
                "__制作人&交付人": corrected
                  ? [{ user_key: "user_annie", name: "Annie" }]
                  : [
                      { user_key: "user_annie", name: "Annie" },
                      { user_key: "user_joy", name: "Joy" },
                    ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update")) corrected = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureContentMaintenanceProducer({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7132735915",
        producerName: "Annie",
      });
    assert.deepEqual(result, {
      roleKey: "role_c17278",
      roleName: "制作人&交付人",
      producerName: "Annie",
      producerUserKey: "user_annie",
    });
    const updateCall = calls.find((call) => call.includes("update"));
    assert.ok(updateCall);
    assert.equal(updateCall?.[updateCall.indexOf("--profile") + 1], "lark-alice");
    const roleOperate = JSON.parse(
      updateCall?.[updateCall.indexOf("--role-operate") + 1] ?? "[]",
    ) as Array<{ op: string; role_key: string; user_keys: string[] }>;
    assert.deepEqual(roleOperate, [
      { op: "remove", role_key: "role_c17278", user_keys: ["user_joy"] },
    ]);
    assert.equal(calls.filter((call) => call.includes("query")).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content producer verification does not mutate an already-correct role", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updateCalls = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("meta-roles")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { roles: [{ role_key: "role_c17278", role_name: "制作人&交付人" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("search")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { users: [{ user_key: "user_annie", name: "Annie" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("query")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          rows: [
            {
              work_item_id: "7132735915",
              "__制作人&交付人": [{ user_key: "user_annie" }],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("update")) updateCalls += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    await new MeegleIdentityManager(config(directory), runner)
      .ensureContentMaintenanceProducer({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7132735915",
        producerName: "Annie",
      });
    assert.equal(updateCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content producer readback accepts generic field records and display names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let updateCalls = 0;
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("meta-roles")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { roles: [{ role_key: "role_c17278", role_name: "制作人&交付人" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("search")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { users: [{ user_key: "user_joy", name: "Joy" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("query")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            rows: [
              {
                work_item_id: "7132856228",
                fields: [
                  {
                    field_key: "role_c17278",
                    field_name: "制作人 & 交付人",
                    field_value: ["Joy"],
                  },
                ],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update")) updateCalls += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureContentMaintenanceProducer({
        identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
        workItemId: "7132856228",
        producerName: "Joy",
      });
    assert.equal(result.producerUserKey, "user_joy");
    assert.equal(updateCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content producer verification stops on ambiguous active users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const runner: ProcessRunner = async (_executable, args) => {
    if (args.includes("meta-roles")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          roles: [{ role_key: "role_c17278", role_name: "制作人&交付人" }],
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        users: [
          { user_key: "user_annie_1", name: "Annie" },
          { user_key: "user_annie_2", name: "Annie" },
        ],
      }),
      stderr: "",
    };
  };

  try {
    await assert.rejects(
      new MeegleIdentityManager(config(directory), runner)
        .ensureContentMaintenanceProducer({
          identity: { profile: "lark-alice", userKey: "meegle_alice", name: "Alice" },
          workItemId: "7132735915",
          producerName: "Annie",
        }),
      /must resolve to one active Meegle user/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("per-user authorization binds a verified sender and reuses only that profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let authenticated = false;
  const calls: string[][] = [];
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === "lark-cli") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { users: [{ open_id: "ou_alice", localized_name: "Alice" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("status")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ authenticated }),
        stderr: "",
      };
    }
    if (args.includes("init")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          client_id: "client",
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://project.feishu.cn/auth/device?code=ABCD-EFGH",
          expires_in: 1800,
        }),
        stderr: "",
      };
    }
    if (args.includes("poll")) {
      authenticated = true;
      return { exitCode: 0, stdout: JSON.stringify({ status: "authorization_pending" }), stderr: "" };
    }
    if (args.includes("user") && args.includes("me")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          user_key: "meegle_alice",
          name_en: "Alice",
          email: "alice@pisell.com",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const manager = new MeegleIdentityManager(config(directory), runner);
    const initial = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "创建客服工单",
    });
    assert.equal(initial.kind, "blocked");
    assert.match(initial.kind === "blocked" ? initial.reply : "", /个人授权/);

    const verified = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "@机器人 已授权",
    });
    assert.equal(verified.kind, "blocked");
    assert.match(verified.kind === "blocked" ? verified.reply : "", /Alice/);

    const allowed = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "重新发送客服工单",
    });
    assert.equal(allowed.kind, "authorized");
    if (allowed.kind === "authorized") {
      assert.equal(allowed.identity.name, "Alice");
      assert.equal(allowed.identity.userKey, "meegle_alice");
      assert.match(allowed.identity.profile, /^lark-[a-f0-9]{16}$/);
      assert.notEqual(allowed.identity.profile, "default");
    }
    const meegleProfiles = calls
      .filter(([executable]) => executable === "meegle")
      .map((call) => call[call.indexOf("--profile") + 1]);
    assert.equal(new Set(meegleProfiles).size, 1);
    assert.ok(
      calls.filter((call) => call.includes("user") && call.includes("me")).length >= 2,
      "the persisted binding is checked against the current Meegle login on every request",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authorization is revoked when the Meegle account belongs to another sender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let logoutCalled = false;
  const runner: ProcessRunner = async (executable, args) => {
    if (executable === "lark-cli") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: [{ open_id: "ou_bob", name: "Bob", email: "bob@pisell.com" }],
        }),
        stderr: "",
      };
    }
    if (args.includes("status")) {
      return { exitCode: 0, stdout: JSON.stringify({ authenticated: true }), stderr: "" };
    }
    if (args.includes("user") && args.includes("me")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          user_key: "meegle_alice",
          name_en: "Alice",
          email: "alice@pisell.com",
        }),
        stderr: "",
      };
    }
    if (args.includes("logout")) logoutCalled = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner).authorize({
      senderId: "ou_bob",
      senderName: "Bob",
      messageText: "创建客服工单",
    });
    assert.equal(result.kind, "blocked");
    assert.match(result.kind === "blocked" ? result.reply : "", /不一致/);
    assert.equal(logoutCalled, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
