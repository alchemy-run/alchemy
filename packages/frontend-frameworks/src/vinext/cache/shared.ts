/**
 * Shared ISR / `"use cache"` entry codec for vinext Node adapters.
 *
 * Mirrors `@vinext/cloudflare` KV data-cache serialization so Redis and
 * S3 store the same JSON shape (ArrayBuffers as base64, tag invalidation
 * timestamps, stale-while-revalidate).
 */
const PATH_TAG_PREFIX = "_N_T_";
const MAX_TAG_LENGTH = 256;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const VALID_KINDS = new Set([
  "FETCH",
  "APP_PAGE",
  "PAGES",
  "APP_ROUTE",
  "REDIRECT",
  "IMAGE",
]);

export const ENTRY_PREFIX = "cache:";
export const TAG_PREFIX = "__tag:";

export const validateTag = (tag: string): string | null => {
  if (
    typeof tag !== "string" ||
    tag.length === 0 ||
    tag.length > MAX_TAG_LENGTH
  ) {
    return null;
  }
  if (/[\x00-\x1f\\:]/.test(tag)) return null;
  return tag;
};

export const validUniqueTags = (tags: ReadonlyArray<string>): Array<string> => {
  const result: Array<string> = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const valid = validateTag(tag);
    if (!valid || seen.has(valid)) continue;
    seen.add(valid);
    result.push(valid);
  }
  return result;
};

export const isPathChildOf = (path: string, prefix: string): boolean => {
  if (prefix === "/") return path.startsWith("/");
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
};

export const pathFromTag = (tag: string): string | undefined => {
  const raw = tag.startsWith(PATH_TAG_PREFIX)
    ? tag.slice(PATH_TAG_PREFIX.length)
    : tag;
  return raw.startsWith("/") ? raw : undefined;
};

export const readStringArrayField = (
  ctx: Record<string, unknown> | undefined,
  field: string,
): Array<string> => {
  const value = ctx?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

export const readPositiveNumberField = (
  ctx: Record<string, unknown> | undefined,
  field: string,
): number | undefined => {
  const value = ctx?.[field];
  return typeof value === "number" && value > 0 ? value : undefined;
};

export const readCacheControlNumberField = (
  ctx: Record<string, unknown> | undefined,
  field: string,
): number | undefined => {
  const control = ctx?.cacheControl;
  if (
    control !== undefined &&
    typeof control === "object" &&
    control !== null
  ) {
    const nested = (control as Record<string, unknown>)[field];
    if (typeof nested === "number") return nested;
  }
  const value = ctx?.[field];
  return typeof value === "number" ? value : undefined;
};

export interface StoredCacheControl {
  readonly revalidate: number;
  readonly expire?: number;
  readonly stale?: number;
}

export interface StoredCacheEntry {
  value: unknown;
  tags: Array<string>;
  lastModified: number;
  revalidateAt: number | null;
  expireAt: number | null;
  cacheControl?: StoredCacheControl;
}

export const isUnknownRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const validateCacheEntry = (raw: unknown): StoredCacheEntry | null => {
  if (!isUnknownRecord(raw)) return null;
  if (typeof raw.lastModified !== "number") return null;
  if (!Array.isArray(raw.tags)) return null;
  if (raw.revalidateAt !== null && typeof raw.revalidateAt !== "number") {
    return null;
  }
  if (
    raw.expireAt !== undefined &&
    raw.expireAt !== null &&
    typeof raw.expireAt !== "number"
  ) {
    return null;
  }
  if (raw.cacheControl !== undefined) {
    if (!isUnknownRecord(raw.cacheControl)) return null;
    if (typeof raw.cacheControl.revalidate !== "number") return null;
  }
  if (raw.value !== null) {
    if (!isUnknownRecord(raw.value)) return null;
    if (
      typeof raw.value.kind !== "string" ||
      !VALID_KINDS.has(raw.value.kind)
    ) {
      return null;
    }
  }
  return raw as unknown as StoredCacheEntry;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string =>
  Buffer.from(buffer).toString("base64");

const safeBase64ToArrayBuffer = (base64: string): ArrayBuffer | null => {
  if (!BASE64_RE.test(base64) || base64.length % 4 !== 0) return null;
  try {
    const buf = Buffer.from(base64, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
};

export const serializeForJSON = (value: Record<string, unknown>): unknown => {
  if (value.kind === "APP_PAGE") {
    return {
      ...value,
      rscData:
        value.rscData instanceof ArrayBuffer
          ? arrayBufferToBase64(value.rscData)
          : value.rscData,
    };
  }
  if (value.kind === "APP_ROUTE") {
    return {
      ...value,
      body:
        value.body instanceof ArrayBuffer
          ? arrayBufferToBase64(value.body)
          : value.body,
    };
  }
  if (value.kind === "IMAGE") {
    return {
      ...value,
      buffer:
        value.buffer instanceof ArrayBuffer
          ? arrayBufferToBase64(value.buffer)
          : value.buffer,
    };
  }
  return value;
};

export const restoreArrayBuffers = (
  value: Record<string, unknown>,
): Record<string, unknown> | null => {
  const restore = (field: string) => {
    const raw = value[field];
    if (typeof raw !== "string") return value;
    const decoded = safeBase64ToArrayBuffer(raw);
    if (!decoded) return null;
    return { ...value, [field]: decoded };
  };
  if (value.kind === "APP_PAGE") return restore("rscData");
  if (value.kind === "APP_ROUTE") return restore("body");
  if (value.kind === "IMAGE") return restore("buffer");
  return value;
};

export const keySpace = (appPrefix: string | undefined) => {
  const prefix = appPrefix ? `${appPrefix}:` : "";
  return {
    entryPrefix: `${prefix}${ENTRY_PREFIX}`,
    entryKey: (key: string) => `${prefix}${ENTRY_PREFIX}${key}`,
    tagKey: (tag: string) => `${prefix}${TAG_PREFIX}${tag}`,
  };
};

/**
 * Read a non-empty string from the adapter `env` bag, then `process.env`.
 * Node `startProdServer` passes `process.env`; Pages Router registration
 * sometimes calls the factory with no env at all.
 */
export const readEnvString = (
  env: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const fromEnv = env?.[key];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (typeof process === "undefined") return undefined;
  const fromProcess = process.env?.[key];
  if (typeof fromProcess === "string" && fromProcess.length > 0) {
    return fromProcess;
  }
  return undefined;
};
