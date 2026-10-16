import assert from "node:assert/strict";
import test from "node:test";

import { resourcesForAttachmentArchive } from "../src/draft-resources.js";
import type { DownloadedResource, DraftSnapshot } from "../src/types.js";

const oldResource: DownloadedResource = {
  type: "image",
  fileKey: "img_old",
  fileName: "old.png",
  localPath: "/tmp/old.png",
};
const currentResource: DownloadedResource = {
  type: "image",
  fileKey: "img_current",
  fileName: "current.png",
  localPath: "/tmp/current.png",
};

function draft(participantFallbackEligible: boolean): DraftSnapshot {
  return {
    id: "draft_1",
    conversationKey: "oc:ou:scope:om_old",
    chatId: "oc",
    senderId: "ou",
    summary: "draft",
    missingFields: [],
    workItemIds: participantFallbackEligible ? [] : ["7130000001"],
    resources: [oldResource],
    participantFallbackEligible,
    updatedAt: 1,
    expiresAt: 2,
  };
}

test("pre-creation draft continuations retain prior evidence", () => {
  assert.deepEqual(
    resourcesForAttachmentArchive({
      activeDraft: draft(true),
      currentResources: [currentResource],
    }).map((resource) => resource.fileKey),
    ["img_old", "img_current"],
  );
});

test("post-write draft updates archive only current-message evidence", () => {
  assert.deepEqual(
    resourcesForAttachmentArchive({
      activeDraft: draft(false),
      currentResources: [currentResource],
    }).map((resource) => resource.fileKey),
    ["img_current"],
  );
});

test("fresh requests never inherit another draft's evidence", () => {
  assert.deepEqual(
    resourcesForAttachmentArchive({ currentResources: [currentResource] }).map(
      (resource) => resource.fileKey,
    ),
    ["img_current"],
  );
});
