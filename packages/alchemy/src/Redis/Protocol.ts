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
      const Client = (
        globalThis as {
          Bun?: {
            RedisClient?: new (url: string) => {
              send: (
                command: string,
                args: readonly string[],
              ) => Promise<unknown>;
            };
          };
        }
      ).Bun?.RedisClient;
      if (Client !== undefined) {
        const client = new Client(url);
        return await client.send(command, [...args]);
      }
      const parsed = new URL(url);
      const tls = parsed.protocol === "rediss:";
      const socket = await Bun.connect({
        hostname: parsed.hostname,
        port: Number(parsed.port || (tls ? TLS_PORT : DEFAULT_PORT)),
        tls,
      });
      const user = decodeURIComponent(parsed.username || "default");
      const pass = decodeURIComponent(parsed.password);
      const frames: string[] = [];
      if (pass.length > 0) {
        frames.push(encodeCommand("AUTH", [user, pass]));
      }
      frames.push(encodeCommand(command, args));
      socket.write(frames.join(""));
      const reader = socket.readable.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      socket.end();
      const raw = new TextDecoder().decode(value ?? new Uint8Array());
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
