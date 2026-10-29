import type {
  ContentMaintenanceProducerSource,
  ContentProducerSelection,
} from "./types.js";

export interface ExplicitProducerResolution {
  producerName?: string;
  requestedName?: string;
  error?: string;
}

export type ExplicitConfirmerRequirement = true | false | undefined;

/**
 * Read only an employee-authored, unambiguous confirmation requirement.
 * Questions are deliberately ignored so they cannot disable producer routing.
 */
export function resolveExplicitConfirmerRequirement(
  text: string,
): ExplicitConfirmerRequirement {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (/(?:不需要|无需|无须|不用|不要)\s*(?:指定|安排|填写|设置)?\s*确认人/iu.test(normalized)) {
    return false;
  }
  if (
    /(?:是否需要|要不要|需不需要)\s*确认人/iu.test(normalized) ||
    /需要\s*确认人(?:确认)?\s*[吗么？?]/iu.test(normalized) ||
    /确认人\s*(?:是)?谁/iu.test(normalized)
  ) {
    return undefined;
  }
  if (
    /(?:需要|需|要)\s*(?:指定|安排|填写|设置)?\s*确认人/iu.test(normalized) ||
    /(?:指定|安排|填写|设置)\s*确认人/iu.test(normalized) ||
    /(?:由|交给)\s*确认人(?:来|负责)?/iu.test(normalized) ||
    /确认人\s+@?(?:[A-Za-z][A-Za-z0-9._-]{0,39}|[\p{Script=Han}]{2,8})/iu.test(
      normalized,
    ) ||
    /确认人\s*(?:是|为|[:：=@])\s*@?(?:[A-Za-z][A-Za-z0-9._-]{0,39}|[\p{Script=Han}]{2,8})/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function rosterMatches(text: string, roster: string[]): string[] {
  const matches: string[] = [];
  const explicitSegments = [
    ...text.matchAll(
      /(?:制作人(?:\s*&\s*交付人)?|负责人|设计师|安排给|指派给|分配给|交给)[^。；;\n]{0,80}/giu,
    ),
  ].map((match) => match[0]);
  for (const name of roster) {
    const escaped = escapeRegExp(name.trim()).replace(/\s+/gu, "\\s+");
    if (!escaped) continue;
    const suffix = /[a-z0-9]$/iu.test(name.trim())
      ? "(?![\\p{L}\\p{N}._-])"
      : "(?![\\p{Script=Han}])";
    const patterns = [
      new RegExp(
        `(?:制作人(?:\\s*&\\s*交付人)?|负责人|设计师)\\s*(?:是|为|[:：=])?\\s*@?${escaped}${suffix}`,
        "iu",
      ),
      new RegExp(
        `(?:优先\\s*)?(?:安排|指派|分配|交给)\\s*(?:给|到)?\\s*@?${escaped}${suffix}`,
        "iu",
      ),
      new RegExp(`(?:^|[\\s,，。;；、])@?${escaped}\\s*(?:来)?(?:负责|制作|处理)`, "iu"),
    ];
    const namedInExplicitSegment = explicitSegments.some((segment) =>
      new RegExp(`(?:^|[^\\p{L}\\p{N}._-])${escaped}${suffix}`, "iu").test(segment),
    );
    if (namedInExplicitSegment || patterns.some((pattern) => pattern.test(text))) {
      matches.push(name);
    }
  }
  return matches;
}

function explicitRequestedName(text: string): string | undefined {
  const token = "([A-Za-z][A-Za-z0-9._-]{0,39}|[\\p{Script=Han}]{2,8})";
  const strongPatterns = [
    new RegExp(
      `(?:制作人(?:\\s*&\\s*交付人)?|负责人|设计师)\\s*(?:是|为|[:：=])\\s*@?${token}`,
      "iu",
    ),
    new RegExp(
      `(?:优先\\s*)?(?:安排|指派|分配|交给)\\s*(?:给|到)\\s*@?${token}`,
      "iu",
    ),
    new RegExp(
      `(?:优先\\s*)?(?:安排|指派|分配|交给)\\s*@?([A-Za-z][A-Za-z0-9._-]{0,39})`,
      "iu",
    ),
    new RegExp(
      `(?:制作人(?:\\s*&\\s*交付人)?|负责人|设计师)\\s*@?([A-Za-z][A-Za-z0-9._-]{0,39})`,
      "iu",
    ),
  ];
  for (const pattern of strongPatterns) {
    const requested = pattern.exec(text)?.[1]?.trim();
    if (requested) return requested;
  }
  return undefined;
}

/**
 * Resolve only an employee-authored explicit producer assignment. A roster
 * match preserves its trusted spelling and casing; an explicitly named person
 * outside the rotation roster is returned for Meegle identity preflight.
 */
export function resolveExplicitProducer(
  text: string,
  producerRoster: string[],
): ExplicitProducerResolution {
  const roster = [
    ...new Map(
      producerRoster
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => [normalizedName(name), name]),
    ).values(),
  ];
  const matches = rosterMatches(text, roster);
  if (matches.length === 1) return { producerName: matches[0]! };
  if (matches.length > 1) {
    return {
      error: `employee message explicitly names multiple producers: ${matches.join(" / ")}`,
    };
  }

  const requestedName = explicitRequestedName(text);
  if (!requestedName) return {};
  const rosterName = roster.find(
    (name) => normalizedName(name) === normalizedName(requestedName),
  );
  if (rosterName) return { producerName: rosterName, requestedName };
  return { producerName: requestedName, requestedName };
}

export interface TrustedProducerResolution {
  producerName?: string;
  selectionMode?: "round_robin_single" | "explicit_single";
  error?: string;
}

/** Validate a model-reported image/text selection against the trusted roster. */
export function resolveTrustedProducerSelection(input: {
  source?: ContentMaintenanceProducerSource;
  reported?: ContentProducerSelection;
}): TrustedProducerResolution {
  const source = input.source;
  if (!source) return {};
  if (source.error) return { error: source.error };
  if (source.selectionMode === "confirmer_assigns") return {};
  const trustedSelected =
    source.producerNames.length === 1 ? source.producerNames[0] : undefined;
  if (!input.reported) {
    return trustedSelected && source.selectionMode !== "all"
      ? {
          producerName: trustedSelected,
          selectionMode:
            source.selectionMode === "explicit_single"
              ? "explicit_single"
              : "round_robin_single",
        }
      : {};
  }

  if (source.selectionMode === "explicit_single") {
    if (
      !trustedSelected ||
      normalizedName(trustedSelected) !== normalizedName(input.reported.producerName)
    ) {
      return { error: "reported producer conflicts with the employee text assignment" };
    }
    return { producerName: trustedSelected, selectionMode: "explicit_single" };
  }

  const rosterMatch = source.producerRoster?.find(
    (name) => normalizedName(name) === normalizedName(input.reported!.producerName),
  );
  if (!rosterMatch) {
    return {
      error: `reported producer is not in the trusted roster: ${input.reported.producerName}`,
    };
  }
  if (input.reported.source === "trusted_default") {
    if (
      !trustedSelected ||
      normalizedName(trustedSelected) !== normalizedName(rosterMatch)
    ) {
      return { error: "reported default producer conflicts with the bridge rotation" };
    }
    return { producerName: rosterMatch, selectionMode: "round_robin_single" };
  }
  return { producerName: rosterMatch, selectionMode: "explicit_single" };
}
