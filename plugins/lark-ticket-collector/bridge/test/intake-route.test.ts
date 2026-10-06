import assert from "node:assert/strict";
import test from "node:test";

import { deriveIntakeRoutePolicy } from "../src/intake-route.js";

test("T3 and content-maintenance creation aliases lock a customer bundle", () => {
  for (const input of [
    "创建T3工单 需要确认人Annie",
    "给我创建内容维护工单",
    "创建客服工单，并配套创建内容维护工单",
  ]) {
    const route = deriveIntakeRoutePolicy(input);
    assert.equal(route.mode, "customer_bundle", input);
    assert.equal(route.customerIssueOption, "T3客户代运营请求-内容维护", input);
    assert.equal(route.pairedWorkItemType, "content_maintenance", input);
    assert.equal(route.authoritative, true, input);
  }
});

test("content maintenance is standalone only when the employee says so explicitly", () => {
  for (const input of [
    "单独创建内容维护工单",
    "只创建内容维护工单，不要客服工单",
    "独立新建一个 T3 工单",
  ]) {
    const route = deriveIntakeRoutePolicy(input);
    assert.equal(route.mode, "standalone", input);
    assert.equal(route.standaloneWorkItemType, "content_maintenance", input);
  }
});

test("green customer-service aliases map to their paired work item", () => {
  const cases = [
    ["创建 T1 工单", "T1核心阻断性问题", "blocking_issue"],
    ["创建 T2 工单", "T2非核心阻断性问题类流转升级", "blocking_issue"],
    ["创建非核心阻断工单", "T2非核心阻断性问题类流转升级", "blocking_issue"],
    ["创建 T5 工单", "T5功能建议/改进类-需求", "demand_pool"],
    ["创建客户刷卡机工单", "客户刷卡机", "customer_card_machine"],
    ["创建刷卡机工单", "客户刷卡机", "customer_card_machine"],
    ["创建一个 Chargeback 风控处理工单", "风控处理", "risk_control"],
    ["创建风控工单", "风控处理", "risk_control"],
  ] as const;

  for (const [input, option, pairedType] of cases) {
    const route = deriveIntakeRoutePolicy(input);
    assert.equal(route.mode, "customer_bundle", input);
    assert.equal(route.customerIssueOption, option, input);
    assert.equal(route.pairedWorkItemType, pairedType, input);
  }
});

test("generic creation starts from customer service while other explicit types retain normal routing", () => {
  assert.equal(deriveIntakeRoutePolicy("给我创建工单").mode, "customer_auto");
  assert.equal(deriveIntakeRoutePolicy("创建客服工单").mode, "customer_auto");
  assert.equal(deriveIntakeRoutePolicy("创建 T4 工单").mode, "customer_only");
  assert.equal(deriveIntakeRoutePolicy("创建一个 CRM 工单").mode, "unspecified");
});

test("queries, updates, and follow-ups do not start a new locked route", () => {
  for (const input of [
    "查询内容维护工单 #7130002718",
    "为什么内容维护工单没有关联客服工单",
    "为什么创建内容维护工单后没有关联客服工单",
    "帮我修改创建内容维护工单的逻辑",
    "@Echo 为什么创建内容维护工单后没有关联客服工单",
    "刚才创建的内容维护工单在哪里",
    "补充店铺 ID 7973",
  ]) {
    assert.equal(deriveIntakeRoutePolicy(input).mode, "unspecified", input);
  }
});

test("explicit blocking issue and T-BUG keep the documented standalone route", () => {
  for (const input of ["创建阻断性问题", "创建 T-BUG 工单"]) {
    const route = deriveIntakeRoutePolicy(input);
    assert.equal(route.mode, "standalone", input);
    assert.equal(route.standaloneWorkItemType, "blocking_issue", input);
  }
});
