import {
  parse as parseIcuMessage,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import type { Catalog } from "./index.js";

export interface ArgumentMismatch {
  id: string;
  source: string[];
  target: string[];
}

export interface CatalogCheckResult {
  missingIds: string[];
  extraIds: string[];
  argumentMismatches: ArgumentMismatch[];
}

function collectArguments(elements: MessageFormatElement[], names: Set<string>): void {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.date:
      case TYPE.number:
      case TYPE.time:
      case TYPE.select:
      case TYPE.plural:
        names.add(element.value);
        if (element.type === TYPE.select || element.type === TYPE.plural) {
          for (const option of Object.values(element.options)) {
            collectArguments(option.value, names);
          }
        }
        break;
      case TYPE.tag:
        collectArguments(element.children, names);
        break;
    }
  }
}

function argumentNames(pattern: string, messageId: string, role: string): string[] {
  try {
    const names = new Set<string>();
    collectArguments(parseIcuMessage(pattern), names);
    return [...names].sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${role} catalog message "${messageId}" has invalid ICU syntax: ${detail}`, {
      cause: error,
    });
  }
}

export function checkCatalogs(source: Catalog, target: Catalog): CatalogCheckResult {
  const sourceIds = Object.keys(source.messages);
  const targetIds = Object.keys(target.messages);
  const targetIdSet = new Set(targetIds);
  const sourceIdSet = new Set(sourceIds);
  const sharedIds = sourceIds.filter((id) => targetIdSet.has(id)).sort();
  const argumentMismatches: ArgumentMismatch[] = [];

  for (const id of sharedIds) {
    const sourceArguments = argumentNames(source.messages[id]!.pattern, id, "Source");
    const targetArguments = argumentNames(target.messages[id]!.pattern, id, "Target");
    if (
      sourceArguments.length !== targetArguments.length ||
      sourceArguments.some((name, index) => name !== targetArguments[index])
    ) {
      argumentMismatches.push({ id, source: sourceArguments, target: targetArguments });
    }
  }

  return {
    missingIds: sourceIds.filter((id) => !targetIdSet.has(id)).sort(),
    extraIds: targetIds.filter((id) => !sourceIdSet.has(id)).sort(),
    argumentMismatches,
  };
}
