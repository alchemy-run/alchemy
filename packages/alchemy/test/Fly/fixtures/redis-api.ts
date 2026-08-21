import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const REDIS_PORT = 3000;

export const RedisSite = Fly.App("RedisSite", {
  enableSubdomains: true,
});

export const Cache = Fly.Redis("Cache");

const pingRedis = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const Client = (
        globalThis as {
          Bun?: {
            RedisClient?: new (url: string) => {
              send: (command: string, args: string[]) => Promise<unknown>;
            };
          };
        }
      ).Bun?.RedisClient;
      if (Client !== undefined) {
        const client = new Client(url);
        return String(await client.send("PING", []));
      }
      const parsed = new URL(url);
      const tls = parsed.protocol === "rediss:";
      const socket = await Bun.connect({
        hostname: parsed.hostname,
        port: Number(parsed.port || (tls ? 6380 : 6379)),
        tls,
      });
      const user = decodeURIComponent(parsed.username || "default");
      const pass = decodeURIComponent(parsed.password);
      const frames: string[] = [];
      if (pass.length > 0) {
        frames.push(
          `*3\r\n$4\r\nAUTH\r\n$${user.length}\r\n${user}\r\n$${pass.length}\r\n${pass}\r\n`,
        );
      }
      frames.push("*1\r\n$4\r\nPING\r\n");
      socket.write(frames.join(""));
      const reader = socket.readable.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      socket.end();
      return new TextDecoder().decode(value ?? new Uint8Array());
    },
    catch: (cause) => cause,
  });

/**
 * HTTP Service that attaches Redis and PING's it via REDIS_URL.
 */
export default class RedisApi extends Fly.Service<RedisApi>()(
  "RedisApi",
  {
    app: RedisSite,
    main: import.meta.url,
    region: "iad",
    port: REDIS_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Fly.Attach(Cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const redisUrl = yield* Config.redacted("REDIS_URL").pipe(
          Effect.orElseSucceed(() => Redacted.make("")),
        );
        const url = Redacted.value(redisUrl);
        if (path === "/health") {
          return yield* HttpServerResponse.json({
            ok: url.length > 0,
          });
        }
        if (url.length === 0) {
          return yield* HttpServerResponse.json(
            { pong: false },
            { status: 503 },
          );
        }
        const pong = yield* pingRedis(url).pipe(
          Effect.map((body) => /pong/i.test(body)),
          Effect.orElseSucceed(() => false),
        );
        return yield* HttpServerResponse.json({ pong });
      }),
    };
  }).pipe(Effect.provide(Fly.AttachLive)),
) {}
