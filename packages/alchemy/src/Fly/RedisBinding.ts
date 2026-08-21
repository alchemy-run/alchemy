import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import {
  REDIS_URL_ENV,
  RedisCommandError,
  RedisUrlMissing,
  type Redis,
} from "./Redis.ts";

/**
 * Shared scaffolding for Upstash Redis bindings.
 *
 * Each `{Op}Http.ts` is a thin `Layer.effect` over {@link makeRedisBinding}.
 * Deploy-time registers the Redis add-on on the host so Service reconcile
 * writes `REDIS_URL`. Runtime commands use that URL internally — callers
 * never read `Config.redacted`.
 *
 * NOT exported from `index.ts`.
 */

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const readValue = (value: unknown): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const direct = asPlain(value);
    if (direct !== undefined) return direct;
    if (Effect.isEffect(value)) {
      return asPlain(yield* value as Effect.Effect<unknown>);
    }
    return undefined;
  });

const redisUrlFromEnv = Config.redacted(REDIS_URL_ENV).pipe(
  Effect.map((value) => Redacted.value(value)),
);

const encodeBulk = (value: string) => `$${value.length}\r\n${value}\r\n`;

const encodeCommand = (command: string, args: readonly string[]) => {
  const parts = [command, ...args];
  return `*${parts.length}\r\n${parts.map(encodeBulk).join("")}`;
};

const decodeReply = (raw: string): unknown => {
  if (raw.startsWith("-")) {
    throw new Error(raw.slice(1).split("\r\n")[0] ?? raw);
  }
  if (raw.startsWith("+")) {
    return raw.slice(1).split("\r\n")[0] ?? "";
  }
  if (raw.startsWith(":")) {
    return Number(raw.slice(1).split("\r\n")[0]);
  }
  if (raw.startsWith("$-1")) {
    return null;
  }
  if (raw.startsWith("$")) {
    const newline = raw.indexOf("\r\n");
    if (newline < 0) return raw;
    const body = raw.slice(newline + 2);
    return body.endsWith("\r\n") ? body.slice(0, -2) : body;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Write one RESP payload and resolve the first response chunk. Only used
 * on runtimes without `Bun.RedisClient`.
 */
const readOneReply = (options: {
  hostname: string;
  port: number;
  tls: boolean;
  payload: string;
}): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (chunk: Uint8Array | undefined) => {
      if (settled) return;
      settled = true;
      resolve(new TextDecoder().decode(chunk ?? new Uint8Array()));
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    Bun.connect({
      hostname: options.hostname,
      port: options.port,
      tls: options.tls,
      socket: {
        open: (socket) => {
          socket.write(options.payload);
        },
        data: (socket, chunk) => {
          finish(chunk);
          socket.end();
        },
        error: (_socket, cause) => fail(cause),
        close: () => finish(undefined),
      },
    }).catch(fail);
  });

const sendCommand = (
  url: string,
  command: string,
  args: readonly string[],
): Effect.Effect<unknown, RedisCommandError, RuntimeContext> =>
  Effect.tryPromise({
    try: async () => {
      // `Bun.RedisClient` landed in Bun 1.2.9; `oven/bun:1` always has it.
      // Older runtimes fall back to a single RESP round-trip over a socket.
      const Client =
        typeof Bun === "undefined"
          ? undefined
          : (Bun.RedisClient as typeof Bun.RedisClient | undefined);
      if (Client !== undefined) {
        const client = new Client(url);
        return await client.send(command, [...args]);
      }
      const parsed = new URL(url);
      const tls = parsed.protocol === "rediss:";
      const user = decodeURIComponent(parsed.username || "default");
      const pass = decodeURIComponent(parsed.password);
      const frames: string[] = [];
      if (pass.length > 0) {
        frames.push(encodeCommand("AUTH", [user, pass]));
      }
      frames.push(encodeCommand(command, args));
      const raw = await readOneReply({
        hostname: parsed.hostname,
        port: Number(parsed.port || (tls ? 6380 : 6379)),
        tls,
        payload: frames.join(""),
      });
      const replies = raw
        .split(/(?=[+*:$-])/)
        .filter((part) => part.length > 0);
      const reply = pass.length > 0 ? replies.at(-1) : replies[0];
      return decodeReply(reply ?? raw);
    },
    catch: (cause) => new RedisCommandError({ command, cause }),
  });

export const makeRedisBinding = <Client>(options: {
  makeClient: (
    url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
  ) => Client;
}) =>
  Effect.succeed(
    Effect.fn(function* (redis: Redis) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${redis}`({
            redis: { name: redis.name, id: redis.redisId },
          });
        }
      }

      const url = redisUrlFromEnv.pipe(
        Effect.mapError(
          () =>
            new RedisUrlMissing({
              name: asPlain(redis.name) ?? redis.LogicalId,
            }),
        ),
      );
      return options.makeClient(url);
    }),
  );

export const redisCommand = (
  url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
  command: string,
  args: readonly string[] = [],
): Effect.Effect<
  unknown,
  RedisCommandError | RedisUrlMissing,
  RuntimeContext
> =>
  Effect.gen(function* () {
    const resolved = yield* url;
    return yield* sendCommand(resolved, command, args);
  });
