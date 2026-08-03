import type { DurableObjectExportState } from "@/Cloudflare/Workers/DurableObjectExports";
import type * as workers from "@distilled.cloud/cloudflare/workers";

const LEGACY_MAPPING_TAG_PREFIX = "alchemy:do:";
const MAPPING_TAG_PREFIX = "alchemy:dos:";
const EXPORT_TAG_PREFIX = "alchemy:doe:";

/** Cloudflare rejects Worker tags larger than 1,024 bytes. */
export const MAX_WORKER_TAG_BYTES = 1024;

const encode = encodeURIComponent;

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const storageCode = (storage: "sqlite" | "legacy-kv") =>
  storage === "sqlite" ? "s" : "k";

const isStorage = (value: unknown): value is "sqlite" | "legacy-kv" =>
  value === "sqlite" || value === "legacy-kv";

const decodeStorage = (value: string) =>
  value === "s" ? "sqlite" : value === "k" ? "legacy-kv" : undefined;

const packRecords = (prefix: string, records: readonly string[]): string[] => {
  const tags: string[] = [];
  let payload = "";
  for (const record of records) {
    const appended = payload === "" ? record : `${payload};${record}`;
    if (
      prefix.length + appended.length > MAX_WORKER_TAG_BYTES &&
      payload !== ""
    ) {
      tags.push(`${prefix}${payload}`);
      payload = record;
    } else {
      payload = appended;
    }
  }
  if (payload !== "") tags.push(`${prefix}${payload}`);
  return tags;
};

/** Pack logical-id to class mappings into bounded Worker tags. */
export const encodeDurableObjectTags = (
  durableObjects: ReadonlyArray<{ logicalId: string; className: string }>,
): string[] =>
  packRecords(
    MAPPING_TAG_PREFIX,
    [...durableObjects]
      .sort((left, right) => left.logicalId.localeCompare(right.logicalId))
      .map(({ logicalId, className }) =>
        logicalId === className
          ? encode(className)
          : `${encode(logicalId)}=${encode(className)}`,
      ),
  );

/** Parse both current packed mappings and the legacy per-object format. */
export const getDurableObjectTagMap = (
  tags: readonly string[],
): Record<string, string> => {
  const mapping: Record<string, string> = {};
  for (const tag of tags) {
    if (!tag.startsWith(LEGACY_MAPPING_TAG_PREFIX)) continue;
    const parts = tag.split(":");
    const logicalId = parts[2];
    const className = parts.slice(3).join(":");
    if (logicalId && className && !(logicalId in mapping)) {
      mapping[logicalId] = className;
    }
  }
  for (const tag of tags) {
    if (!tag.startsWith(MAPPING_TAG_PREFIX)) continue;
    for (const pair of tag.slice(MAPPING_TAG_PREFIX.length).split(";")) {
      if (pair === "") continue;
      const separator = pair.indexOf("=");
      const logicalId = decode(
        separator === -1 ? pair : pair.slice(0, separator),
      );
      const className = decode(
        separator === -1 ? pair : pair.slice(separator + 1),
      );
      if (logicalId && className) mapping[logicalId] = className;
    }
  }
  return mapping;
};

/**
 * Persist the submitted Durable Object export contract in the same Worker
 * upload as the contract itself. This makes retries recoverable even when
 * Cloudflare's settings response omits its documented `exports` field.
 */
export const encodeDurableObjectExportTags = (
  submitted: workers.PutScriptExports | undefined,
): string[] => {
  if (submitted === undefined) return [];
  const records: string[] = [];

  for (const [className, entry] of Object.entries(submitted).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (entry === undefined || entry.type !== "durable-object") continue;
    const encodedClassName = encode(className);
    if (entry.state === "deleted") {
      records.push(`d:${encodedClassName}`);
      continue;
    }
    if (entry.state === "renamed" && "renamedTo" in entry) {
      records.push(`r:${encodedClassName}:${encode(entry.renamedTo)}`);
      continue;
    }
    if (entry.state === "transferred" && "transferredTo" in entry) {
      records.push(`t:${encodedClassName}:${encode(entry.transferredTo)}`);
      continue;
    }
    if (!("storage" in entry) || !isStorage(entry.storage)) continue;
    const storage = entry.storage;
    const container =
      "container" in entry && typeof entry.container === "string"
        ? `:${encode(entry.container)}`
        : "";
    if (entry.state === "expecting-transfer" && "transferFrom" in entry) {
      records.push(
        `p:${encodedClassName}:${storageCode(storage)}:${encode(entry.transferFrom)}${container}`,
      );
      continue;
    }
    records.push(`l:${encodedClassName}:${storageCode(storage)}${container}`);
  }

  return packRecords(EXPORT_TAG_PREFIX, records);
};

/** Read a previously submitted export contract from live Worker tags. */
export const getDurableObjectExportStateFromTags = (
  tags: readonly string[],
): DurableObjectExportState | undefined => {
  const tombstones: DurableObjectExportState["tombstones"] = {};
  const pendingTransfers: DurableObjectExportState["pendingTransfers"] = {};
  const storageByClass: DurableObjectExportState["storageByClass"] = {};

  for (const tag of tags) {
    if (!tag.startsWith(EXPORT_TAG_PREFIX)) continue;
    const payload = tag.slice(EXPORT_TAG_PREFIX.length);
    for (const record of payload.split(";")) {
      const [kind, encodedClassName, value, source, encodedContainer] =
        record.split(":");
      const className =
        encodedClassName === undefined ? undefined : decode(encodedClassName);
      if (className === undefined || className === "") continue;

      if (kind === "d") {
        tombstones[className] = { type: "durable-object", state: "deleted" };
        continue;
      }
      if (kind === "r" || kind === "t") {
        const target = value === undefined ? undefined : decode(value);
        if (target === undefined || target === "") continue;
        tombstones[className] =
          kind === "r"
            ? {
                type: "durable-object",
                state: "renamed",
                renamedTo: target,
              }
            : {
                type: "durable-object",
                state: "transferred",
                transferredTo: target,
              };
        continue;
      }
      if (kind !== "l" && kind !== "p") continue;
      const storage = value === undefined ? undefined : decodeStorage(value);
      if (storage === undefined) continue;

      if (kind === "p") {
        const transferFrom = source === undefined ? undefined : decode(source);
        const container =
          encodedContainer === undefined ? undefined : decode(encodedContainer);
        if (transferFrom === undefined || transferFrom === "") continue;
        storageByClass[className] = storage;
        pendingTransfers[className] = {
          transferFrom,
          storage,
          ...(container === undefined || container === "" ? {} : { container }),
        };
      } else {
        storageByClass[className] = storage;
      }
    }
  }

  return Object.keys(tombstones).length > 0 ||
    Object.keys(pendingTransfers).length > 0 ||
    Object.keys(storageByClass).length > 0
    ? {
        tombstones,
        pendingTransfers,
        storageByClass,
        cleanupClassNames: [],
      }
    : undefined;
};

export const isDurableObjectTag = (tag: string): boolean =>
  tag.startsWith(LEGACY_MAPPING_TAG_PREFIX) ||
  tag.startsWith(MAPPING_TAG_PREFIX) ||
  tag.startsWith(EXPORT_TAG_PREFIX);
