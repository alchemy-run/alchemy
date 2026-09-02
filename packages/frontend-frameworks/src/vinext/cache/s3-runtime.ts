/**
 * vinext data-cache adapter backed by S3. Default export is the factory
 * `virtual:vinext-cache-adapters` calls as `({ env, options }) => CacheHandler`.
 *
 * Uses `@aws-sdk/client-s3` (the Lambda Node.js runtime ships SDK v3).
 */
import {
  isUnknownRecord,
  keySpace,
  readCacheControlNumberField,
  readEnvString,
  readPositiveNumberField,
  readStringArrayField,
  restoreArrayBuffers,
  serializeForJSON,
  validateCacheEntry,
  validateTag,
  validUniqueTags,
  type StoredCacheControl,
} from "./shared.ts";

export interface S3AdapterOptions extends Record<string, unknown> {
  /** Env var holding the bucket name. @default "CACHE_BUCKET_NAME" */
  readonly bucketEnv?: string;
  /** Key prefix inside the bucket. @default "vinext-cache/" */
  readonly prefix?: string;
  readonly appPrefix?: string;
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_BUCKET_ENV = "CACHE_BUCKET_NAME";
const DEFAULT_PREFIX = "vinext-cache/";

type S3 = {
  send: (command: unknown) => Promise<unknown>;
};

type S3Commands = {
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  PutObjectCommand: new (input: {
    Bucket: string;
    Key: string;
    Body: string;
    ContentType: string;
  }) => unknown;
  DeleteObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
};

const loadS3 = async () => {
  // Keep the specifier out of the static graph so vinext/Rolldown does
  // not try to bundle the SDK. Lambda's Node.js runtime provides it.
  const load = new Function("id", "return import(id)") as (
    id: string,
  ) => Promise<{
    S3Client: new (config?: { region?: string }) => S3;
    GetObjectCommand: S3Commands["GetObjectCommand"];
    PutObjectCommand: S3Commands["PutObjectCommand"];
    DeleteObjectCommand: S3Commands["DeleteObjectCommand"];
  }>;
  return load("@aws-sdk/client-s3");
};

const bodyToString = async (body: unknown): Promise<string> => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToString" in body
  ) {
    return await (
      body as { transformToString: () => Promise<string> }
    ).transformToString();
  }
  throw new Error("Unsupported S3 body type");
};

class S3CacheHandler {
  readonly #client: S3;
  readonly #commands: S3Commands;
  readonly #bucket: string;
  readonly #keys: ReturnType<typeof keySpace>;
  readonly #objectPrefix: string;
  readonly #tagCacheTtl: number;
  readonly #tagCache = new Map<
    string,
    { timestamp: number; fetchedAt: number }
  >();

  constructor(
    client: S3,
    commands: S3Commands,
    bucket: string,
    options: S3AdapterOptions | undefined,
  ) {
    this.#client = client;
    this.#commands = commands;
    this.#bucket = bucket;
    this.#objectPrefix = options?.prefix ?? DEFAULT_PREFIX;
    this.#keys = keySpace(options?.appPrefix);
    this.#tagCacheTtl = options?.tagCacheTtlMs ?? 5_000;
  }

  #objectKey(logical: string) {
    return `${this.#objectPrefix}${logical}`;
  }

  async #getText(key: string): Promise<string | undefined> {
    try {
      const result = (await this.#client.send(
        new this.#commands.GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
        }),
      )) as { Body?: unknown };
      return await bodyToString(result.Body);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return undefined;
      throw error;
    }
  }

  async #putText(key: string, value: string) {
    await this.#client.send(
      new this.#commands.PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#objectKey(key),
        Body: value,
        ContentType: "application/json",
      }),
    );
  }

  async #delete(key: string) {
    await this.#client.send(
      new this.#commands.DeleteObjectCommand({
        Bucket: this.#bucket,
        Key: this.#objectKey(key),
      }),
    );
  }

  async get(key: string, ctx?: Record<string, unknown>) {
    const raw = await this.#getText(this.#keys.entryKey(key));
    if (raw === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#delete(this.#keys.entryKey(key));
      return null;
    }
    const entry = validateCacheEntry(parsed);
    if (!entry) {
      await this.#delete(this.#keys.entryKey(key));
      return null;
    }
    let restoredValue = null;
    if (entry.value && isUnknownRecord(entry.value)) {
      restoredValue = restoreArrayBuffers(entry.value);
      if (!restoredValue) {
        await this.#delete(this.#keys.entryKey(key));
        return null;
      }
    }
    if (
      await this.#hasRevalidatedTag(
        validUniqueTags(entry.tags),
        entry.lastModified,
      )
    ) {
      await this.#delete(this.#keys.entryKey(key));
      return null;
    }
    const softTags = validUniqueTags(readStringArrayField(ctx, "softTags"));
    if (await this.#hasRevalidatedTag(softTags, entry.lastModified))
      return null;
    if (entry.expireAt !== null && Date.now() > entry.expireAt) {
      await this.#delete(this.#keys.entryKey(key));
      return null;
    }
    const now = Date.now();
    const requestedRevalidate = readPositiveNumberField(ctx, "revalidate");
    const requestedRevalidateAt =
      requestedRevalidate === undefined
        ? null
        : entry.lastModified + requestedRevalidate * 1000;
    if (
      (entry.revalidateAt !== null && now > entry.revalidateAt) ||
      (requestedRevalidateAt !== null && now > requestedRevalidateAt)
    ) {
      return {
        lastModified: entry.lastModified,
        value: restoredValue,
        cacheState: "stale",
        cacheControl: entry.cacheControl,
      };
    }
    return {
      lastModified: entry.lastModified,
      value: restoredValue,
      cacheControl: entry.cacheControl,
    };
  }

  async set(
    key: string,
    data: Record<string, unknown> | null,
    ctx?: Record<string, unknown>,
  ) {
    const tagSet = new Set<string>();
    if (data && Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        if (typeof tag === "string") {
          const valid = validateTag(tag);
          if (valid) tagSet.add(valid);
        }
      }
    }
    if (ctx && Array.isArray(ctx.tags)) {
      for (const tag of ctx.tags) {
        if (typeof tag === "string") {
          const valid = validateTag(tag);
          if (valid) tagSet.add(valid);
        }
      }
    }
    let effectiveRevalidate = readCacheControlNumberField(ctx, "revalidate");
    const effectiveExpire = readCacheControlNumberField(ctx, "expire");
    const effectiveStale = readCacheControlNumberField(ctx, "stale");
    if (data && typeof data.revalidate === "number") {
      effectiveRevalidate = data.revalidate;
    }
    if (effectiveRevalidate === 0) return;
    const now = Date.now();
    const revalidateAt =
      typeof effectiveRevalidate === "number" && effectiveRevalidate > 0
        ? now + effectiveRevalidate * 1000
        : null;
    const expireAt =
      typeof effectiveExpire === "number" && effectiveExpire > 0
        ? now + effectiveExpire * 1000
        : null;
    const cacheControl: StoredCacheControl | undefined =
      typeof effectiveRevalidate === "number"
        ? {
            revalidate: effectiveRevalidate,
            ...(effectiveExpire === undefined
              ? {}
              : { expire: effectiveExpire }),
            ...(effectiveStale === undefined ? {} : { stale: effectiveStale }),
          }
        : undefined;
    const entry = {
      value: data ? serializeForJSON(data) : null,
      tags: [...tagSet],
      lastModified: now,
      revalidateAt,
      expireAt,
      cacheControl,
    };
    await this.#putText(this.#keys.entryKey(key), JSON.stringify(entry));
  }

  async revalidateTag(tags: string | Array<string>) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = Date.now();
    const validTags = tagList.filter((tag) => validateTag(tag) !== null);
    await Promise.all(
      validTags.map((tag) =>
        this.#putText(this.#keys.tagKey(tag), String(now)),
      ),
    );
    for (const tag of validTags) {
      this.#tagCache.set(tag, { timestamp: now, fetchedAt: now });
    }
  }

  resetRequestCache() {
    this.#tagCache.clear();
  }

  async #hasRevalidatedTag(tags: Array<string>, lastModified: number) {
    if (tags.length === 0) return false;
    const now = Date.now();
    const uncached: Array<string> = [];
    for (const tag of tags) {
      const cached = this.#tagCache.get(tag);
      if (cached && now - cached.fetchedAt < this.#tagCacheTtl) {
        if (
          Number.isNaN(cached.timestamp) ||
          cached.timestamp >= lastModified
        ) {
          return true;
        }
      } else {
        uncached.push(tag);
      }
    }
    if (uncached.length === 0) return false;
    const results = await Promise.all(
      uncached.map((tag) => this.#getText(this.#keys.tagKey(tag))),
    );
    for (let i = 0; i < uncached.length; i++) {
      const raw = results[i];
      const timestamp = raw !== undefined ? Number(raw) : 0;
      this.#tagCache.set(uncached[i]!, { timestamp, fetchedAt: now });
      if (
        timestamp !== 0 &&
        (Number.isNaN(timestamp) || timestamp >= lastModified)
      ) {
        return true;
      }
    }
    return false;
  }
}

const createS3DataCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: S3AdapterOptions;
}) => {
  const bucketEnv = options?.bucketEnv ?? DEFAULT_BUCKET_ENV;
  const bucket = readEnvString(env, bucketEnv);
  if (bucket === undefined) {
    throw new Error(
      `[vinext] The S3 data cache adapter requires \`${bucketEnv}\` in the process environment.`,
    );
  }
  let handler: S3CacheHandler | undefined;
  const ready = loadS3().then((sdk) => {
    const region = readEnvString(env, "AWS_REGION");
    handler = new S3CacheHandler(
      new sdk.S3Client(region !== undefined ? { region } : {}),
      {
        GetObjectCommand: sdk.GetObjectCommand,
        PutObjectCommand: sdk.PutObjectCommand,
        DeleteObjectCommand: sdk.DeleteObjectCommand,
      },
      bucket,
      options,
    );
    return handler;
  });
  return {
    async get(key: string, ctx?: Record<string, unknown>) {
      return (handler ?? (await ready)).get(key, ctx);
    },
    async set(
      key: string,
      data: Record<string, unknown> | null,
      ctx?: Record<string, unknown>,
    ) {
      return (handler ?? (await ready)).set(key, data, ctx);
    },
    async revalidateTag(tags: string | Array<string>) {
      return (handler ?? (await ready)).revalidateTag(tags);
    },
    resetRequestCache() {
      handler?.resetRequestCache();
    },
  };
};

export default createS3DataCacheAdapter;
