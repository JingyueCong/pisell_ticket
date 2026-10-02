import type { ContentMaintenanceProducerSourceConfig } from "./config.js";

export function parseProducerNames(
  chatName: string,
  config: ContentMaintenanceProducerSourceConfig,
): string[] {
  const match = new RegExp(config.extractPattern).exec(chatName);
  if (!match?.[1]) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of match[1].split(new RegExp(config.nameSplitPattern))) {
    const name = value.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}
