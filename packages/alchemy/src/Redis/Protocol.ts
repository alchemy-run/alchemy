import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { CommandError, type UrlMissing } from "./Errors.ts";

export const DEFAULT_PORT = 6379;
export const TLS_PORT = 6380;

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

/** Build a `redis://` URL. Encodes the password. Used by tests and TcpProxy. */
export const connectionUrl = (input: {
  host: string;
  port: number;
  password: string;
  username?: string;
}): string => {
  const username = input.username ?? "default";
  return `redis://${username}:${encodeURIComponent(input.password)}@${input.host}:${input.port}`;
};

/**
 * Send one Redis command over RESP. Prefers `Bun.RedisClient` when
 * present; otherwise a one-shot `Bun.connect`.
 */
export const run = (
  url: string,
  command: string,
  args: readonly string[] = [],
): Effect.Effect<unknown, CommandError> =>
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
        port: Number(parsed.port || (tls ? TLS_PORT : DEFAULT_PORT)),
        tls,
        payload: frames.join(""),
      });
      const replies = raw
        .split(/(?=[+*:$-])/)
        .filter((part) => part.length > 0);
      const reply = pass.length > 0 ? replies.at(-1) : replies[0];
      return decodeReply(reply ?? raw);
    },
    catch: (cause) => new CommandError({ command, cause }),
  });

export const command = (
  url: Effect.Effect<string, UrlMissing, RuntimeContext>,
  name: string,
  args: readonly string[] = [],
): Effect.Effect<unknown, CommandError | UrlMissing, RuntimeContext> =>
  Effect.gen(function* () {
    const resolved = yield* url;
    return yield* run(resolved, name, args);
  });
