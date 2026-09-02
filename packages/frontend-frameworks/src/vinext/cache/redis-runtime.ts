/**
 * vinext data-cache adapter backed by Redis. Default export is the
 * factory `virtual:vinext-cache-adapters` calls as
 * `({ env, options }) => CacheHandler`.
 *
 * Speaks a tiny RESP subset over `node:net` / `node:tls` so the
 * Railway/Fly image does not need a `redis` npm package.
 */
import * as net from "node:net";
import * as tls from "node:tls";
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

export interface RedisAdapterOptions extends Record<string, unknown> {
  /** Env var holding the Redis URL. @default "REDIS_URL" */
  readonly urlEnv?: string;
  readonly appPrefix?: string;
  /** Default key TTL in seconds. @default 2592000 (30 days) */
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_URL_ENV = "REDIS_URL";
const DEFAULT_TTL_SECONDS = 2592000;

type RedisValue = string | null | number | "OK";

class RedisClient {
  #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: Array<(value: RedisValue | Error) => void> = [];
  #closed = false;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.from(Buffer.concat([this.#buffer, chunk]));
      this.#drain();
    });
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => {
      this.#closed = true;
      this.#failAll(new Error("Redis connection closed"));
    });
  }

  static connect(urlString: string): Promise<RedisClient> {
    const url = new URL(urlString);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "rediss:"
        ? 6380
        : 6379;
    const host = url.hostname;
    const useTls = url.protocol === "rediss:";
    return new Promise((resolve, reject) => {
      const socket = useTls
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", async () => {
        socket.off("error", onError);
        const client = new RedisClient(socket);
        try {
          if (url.password) {
            const user =
              url.username && url.username !== "default"
                ? url.username
                : undefined;
            const auth = user
              ? await client.send([
                  "AUTH",
                  user,
                  decodeURIComponent(url.password),
                ])
              : await client.send(["AUTH", decodeURIComponent(url.password)]);
            if (auth !== "OK") {
              throw new Error(`Redis AUTH failed: ${String(auth)}`);
            }
          }
          if (url.pathname && url.pathname !== "/" && url.pathname.length > 1) {
            const db = url.pathname.slice(1);
            await client.send(["SELECT", db]);
          }
          resolve(client);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
    });
  }

  send(args: Array<string>): Promise<RedisValue> {
    if (this.#closed)
      return Promise.reject(new Error("Redis connection closed"));
    return new Promise((resolve, reject) => {
      this.#pending.push((value) => {
        if (value instanceof Error) reject(value);
        else resolve(value);
      });
      this.#socket.write(encodeCommand(args));
    });
  }

  #failAll(error: Error) {
    const pending = this.#pending.splice(0);
    for (const resume of pending) resume(error);
  }

  #drain() {
    while (this.#pending.length > 0) {
      const parsed = decodeReply(this.#buffer);
      if (!parsed) return;
      this.#buffer = Buffer.from(parsed.rest);
      const resume = this.#pending.shift();
      resume?.(parsed.value);
    }
  }
}

const encodeCommand = (args: Array<string>): Buffer => {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const buf = Buffer.from(arg);
    parts.push(`$${buf.length}\r\n`, arg, "\r\n");
  }
  return Buffer.from(parts.join(""));
};

const decodeReply = (
  buffer: Buffer,
): { value: RedisValue; rest: Buffer } | undefined => {
  const text = buffer.toString("utf8");
  const headerEnd = text.indexOf("\r\n");
  if (headerEnd < 0) return undefined;
  const prefix = text[0];
  const header = text.slice(1, headerEnd);
  const restStart = headerEnd + 2;
  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const rest = buffer.subarray(Buffer.byteLength(text.slice(0, restStart)));
    if (prefix === "-") return { value: new Error(header) as never, rest };
    if (prefix === ":") return { value: Number(header), rest };
    return { value: header === "OK" ? "OK" : header, rest };
  }
  if (prefix === "$") {
    const size = Number(header);
    if (size < 0) {
      return {
        value: null,
        rest: buffer.subarray(Buffer.byteLength(text.slice(0, restStart))),
      };
    }
    const bodyStart = restStart;
    const body = buffer.subarray(bodyStart, bodyStart + size);
    if (body.length < size) return undefined;
    const after = buffer.subarray(bodyStart + size);
    if (after.length < 2) return undefined;
    return { value: body.toString("utf8"), rest: after.subarray(2) };
  }
  throw new Error(`Unsupported Redis reply: ${prefix}`);
};

class RedisCacheHandler {
  readonly #client: RedisClient;
  readonly #keys: ReturnType<typeof keySpace>;
  readonly #ttlSeconds: number;
  readonly #tagCacheTtl: number;
  readonly #tagCache = new Map<
    string,
    { timestamp: number; fetchedAt: number }
  >();

  constructor(client: RedisClient, options: RedisAdapterOptions | undefined) {
    this.#client = client;
    this.#keys = keySpace(options?.appPrefix);
    this.#ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#tagCacheTtl = options?.tagCacheTtlMs ?? 5_000;
  }

  async get(key: string, ctx?: Record<string, unknown>) {
    const raw = await this.#client.send(["GET", this.#keys.entryKey(key)]);
    if (typeof raw !== "string") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#client.send(["DEL", this.#keys.entryKey(key)]);
      return null;
    }
    const entry = validateCacheEntry(parsed);
    if (!entry) {
      await this.#client.send(["DEL", this.#keys.entryKey(key)]);
      return null;
    }
    let restoredValue = null;
    if (entry.value && isUnknownRecord(entry.value)) {
      restoredValue = restoreArrayBuffers(entry.value);
      if (!restoredValue) {
        await this.#client.send(["DEL", this.#keys.entryKey(key)]);
        return null;
      }
    }
    if (
      await this.#hasRevalidatedTag(
        validUniqueTags(entry.tags),
        entry.lastModified,
      )
    ) {
      await this.#client.send(["DEL", this.#keys.entryKey(key)]);
      return null;
    }
    const softTags = validUniqueTags(readStringArrayField(ctx, "softTags"));
    if (await this.#hasRevalidatedTag(softTags, entry.lastModified))
      return null;
    if (entry.expireAt !== null && Date.now() > entry.expireAt) {
      await this.#client.send(["DEL", this.#keys.entryKey(key)]);
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
    const ttlMs =
      expireAt !== null
        ? Math.max(expireAt - now, 1000)
        : this.#ttlSeconds * 1000;
    await this.#client.send([
      "SET",
      this.#keys.entryKey(key),
      JSON.stringify(entry),
      "PX",
      String(ttlMs),
    ]);
  }

  async revalidateTag(tags: string | Array<string>) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = Date.now();
    const validTags = tagList.filter((tag) => validateTag(tag) !== null);
    await Promise.all(
      validTags.map((tag) =>
        this.#client.send([
          "SET",
          this.#keys.tagKey(tag),
          String(now),
          "PX",
          String(this.#ttlSeconds * 1000),
        ]),
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
      uncached.map((tag) => this.#client.send(["GET", this.#keys.tagKey(tag)])),
    );
    for (let i = 0; i < uncached.length; i++) {
      const raw = results[i];
      const timestamp = typeof raw === "string" ? Number(raw) : 0;
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

const redisClients = new Map<string, Promise<RedisClient>>();

const getClient = (url: string) => {
  const existing = redisClients.get(url);
  if (existing) return existing;
  const created = RedisClient.connect(url);
  redisClients.set(url, created);
  created.catch(() => redisClients.delete(url));
  return created;
};

const createRedisDataCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: RedisAdapterOptions;
}) => {
  const urlEnv = options?.urlEnv ?? DEFAULT_URL_ENV;
  const url = readEnvString(env, urlEnv);
  if (url === undefined) {
    throw new Error(
      `[vinext] The Redis data cache adapter requires \`${urlEnv}\` in the process environment.`,
    );
  }
  // CacheHandler methods are async; connect lazily on first get/set so
  // registration stays sync (vinext's generated module calls the factory
  // synchronously).
  let handler: RedisCacheHandler | undefined;
  const ready = getClient(url).then((client) => {
    handler = new RedisCacheHandler(client, options);
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

export default createRedisDataCacheAdapter;
