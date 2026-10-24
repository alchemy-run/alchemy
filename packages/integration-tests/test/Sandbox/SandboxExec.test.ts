import type { SandboxExecOptions } from "@alchemy.run/sandbox/Sandbox";
import { execOverSocket } from "@alchemy.run/sandbox/SandboxExec";
import { describe, expect, layer } from "@alchemy.run/test";
import { serveEgressControl } from "alchemy/Egress/Proxy";
import type { Route } from "alchemy/Egress/Route";
import { serveExec } from "alchemy/Runtime/ExecServer";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const SECRET = "s3cret";
const decoder = new TextDecoder();
const text = (buffer: ArrayBuffer) => decoder.decode(buffer);

/** A control server with exec mounted, as a sandbox's bootstrap runs it. */
const controlServer = Effect.gen(function* () {
  const routes = yield* SubscriptionRef.make<ReadonlyArray<Route>>([]);
  const { port } = yield* serveEgressControl({
    port: 0,
    host: "127.0.0.1",
    routes,
    secret: Redacted.make(SECRET),
    exec: serveExec,
  });
  return port;
});

/** A WebSocket to `GET /exec`, the way a host's client opens one. */
const connect = (port: number, secret = SECRET) =>
  Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(`ws://127.0.0.1:${port}/exec`, {
            headers: { Authorization: `Bearer ${secret}` },
          } as unknown as string[]) as unknown as Socket.WebSocketLike,
      ),
      (ws) => Effect.sync(() => ws.close(1000)),
    ),
  );

const exec = (port: number, cmd: ReadonlyArray<string>, options?: SandboxExecOptions) =>
  Effect.flatMap(connect(port), (socket) => execOverSocket(socket, cmd, options));

layer(PlatformServices, { excludeTestServices: true })("Sandbox.SandboxExec", (it) => {
  describe("exec over a socket to the bootstrap", { tags: ["local"] }, () => {
    it.effect(
      "runs a command: stdout, stderr and the exit code",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const process = yield* exec(port, ["sh", "-c", "echo out; echo err >&2; exit 3"]);
          expect(process.pid).toBeGreaterThan(0);
          const output = yield* process.output();
          expect(text(output.stdout)).toBe("out\n");
          expect(text(output.stderr)).toBe("err\n");
          expect(output.exitCode).toBe(3);
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );

    it.effect(
      "pipes stdin, and closes it when the sink completes",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const process = yield* exec(port, ["cat"], { stdin: "pipe" });
          yield* Stream.make(
            new TextEncoder().encode("hello "),
            new TextEncoder().encode("world"),
          ).pipe(Stream.run(process.stdin!));
          const output = yield* process.output();
          expect(text(output.stdout)).toBe("hello world");
          expect(output.exitCode).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );

    it.effect(
      "combines stderr into stdout, and runs in cwd with env",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const process = yield* exec(port, ["sh", "-c", 'pwd; echo "$GREETING" >&2'], {
            cwd: "/tmp",
            env: { GREETING: "hi" },
            stderr: "combined",
          });
          expect(process.stderr).toBeUndefined();
          const output = yield* process.output();
          expect(text(output.stdout)).toMatch(/\/tmp\nhi\n$/);
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );

    it.effect(
      "kill signals the process; its exit code reports the signal",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const process = yield* exec(port, ["sleep", "30"]);
          yield* process.kill();
          expect(yield* process.exitCode).toBe(128 + 15);
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );

    it.effect(
      "a command that can't start fails",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const error = yield* exec(port, ["alchemy-no-such-command"]).pipe(Effect.flip);
          expect(error._tag).toBe("SandboxError");
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );

    it.effect(
      "a wrong secret is refused",
      () =>
        Effect.gen(function* () {
          const port = yield* controlServer;
          const error = yield* Effect.flatMap(connect(port, "wrong"), (socket) =>
            execOverSocket(socket, ["true"]),
          ).pipe(Effect.flip);
          expect(error._tag).toBe("SandboxError");
        }).pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)),
      { timeout: 30_000 },
    );
  });
});
