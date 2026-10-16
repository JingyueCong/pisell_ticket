import type { DownloadedResource, DraftSnapshot } from "./types.js";

/**
 * Pending pre-creation drafts retain their evidence across missing-field
 * follow-ups. After any real work-item write, historical evidence has already
 * been archived and must not be uploaded again; only current-message files are
 * eligible for a later explicit update.
 */
export function resourcesForAttachmentArchive(input: {
  activeDraft?: DraftSnapshot;
  currentResources: DownloadedResource[];
}): DownloadedResource[] {
  const inherited =
    input.activeDraft?.participantFallbackEligible === false
      ? []
      : input.activeDraft?.resources ?? [];
  const merged = new Map<string, DownloadedResource>();
  for (const resource of [...inherited, ...input.currentResources]) {
    merged.set(resource.fileKey, resource);
  }
  return [...merged.values()];
}
