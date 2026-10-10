import type { ContentMaintenanceProducerSourceConfig } from "./config.js";

function parseNames(
  chatName: string,
  extractPattern: string,
  splitPattern: string,
): string[] {
  const match = new RegExp(extractPattern).exec(chatName);
  if (!match?.[1]) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of match[1].split(new RegExp(splitPattern))) {
    const name = value.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function parseProducerNames(
  chatName: string,
  config: ContentMaintenanceProducerSourceConfig,
): string[] {
  return parseNames(chatName, config.extractPattern, config.nameSplitPattern);
}

export function parseConfirmerNames(
  chatName: string,
  config: ContentMaintenanceProducerSourceConfig,
): string[] {
  return parseNames(
    chatName,
    config.confirmerExtractPattern,
    config.confirmerNameSplitPattern,
  );
}
