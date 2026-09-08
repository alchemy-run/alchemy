import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BunHttpServer, HttpServer } from "../Http.ts";
import { serveRpc } from "../Rpc.ts";
import * as Workspace from "../Workspace/Workspace.ts";
import { makeSandboxLocal } from "./SandboxLocal.ts";
import { makeSandboxPty } from "./SandboxPty.ts";

export interface ServeSandboxOptions {
  /** Absolute path of the tree to serve as the sandbox's workspace root. */
  readonly root: string;
  /**
   * Port to listen on. `0` asks the OS for a free one. A port another
   * process holds is NOT fatal: the next ports up are tried (like the
   * dev Worker proxy does for 1337/1340), then an ephemeral one — the
   * bound address is what gets printed, and a `Command.Dev` wrapper
   * picks THAT up as its `url`, so a client that reads the address at
   * runtime never notices. Set `strictPort` to fail instead.
   * @default `PORT` from the environment, else `0`
   */
  readonly port?: number;
  /**
   * Fail when `port` is taken instead of falling back.
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * Interface to bind. The server runs shells and reads/writes files as
   * the current user — keep it on the loopback interface.
   * @default "127.0.0.1"
   */
  readonly hostname?: string;
}

/**
 * Serve a directory as a sandbox machine over the guest RPC protocol —
 * the SAME physics the AWS MicroVM / Cloudflare Container guests run
 * (`makeSandboxLocal` + `makeSandboxPty`), from a plain **Bun** process
 * on the developer's machine. The client is {@link SandboxHttp}.
 *
 * Prints `http://localhost:<port>` once listening, so a `Command.Dev`
 * wrapping it picks the address up as its `url`:
 *
 * ```ts
 * // scripts/sandbox-dev.ts — run by `Command.Dev("Sandbox", { command: "bun scripts/sandbox-dev.ts" })`
 * await Effect.runPromise(AI.serveSandbox({ root: process.cwd() }));
 * ```
 *
 * Runs until interrupted. Requires Bun (the PTY rides `Bun.Terminal`).
 */
export const serveSandbox = (
  options: ServeSandboxOptions,
): Effect.Effect<never> =>
  Effect.gen(function* () {
    // the platform services are a Bun-only peer: resolve them lazily so
    // this module stays importable from the AI barrel in every runtime
    const BunServices = yield* Effect.promise(
      () => import("@effect/platform-bun/BunServices"),
    );
    const port =
      options.port ??
      (yield* Config.number("PORT").pipe(Config.withDefault(0), Effect.orDie));
    const hostname = options.hostname ?? "127.0.0.1";

    return yield* Effect.gen(function* () {
      const sandbox = yield* makeSandboxLocal;
      const pty = yield* makeSandboxPty;
      const server = yield* HttpServer;
      const handler = serveRpc(
        { ...sandbox, ...pty },
        HttpServerResponse.json({ ok: true, root: options.root }),
      );
      // the bind is the only thing that can fail here; once listening
      // the server runs until interrupted, so a failure past `serve`
      // is never a port collision
      const serveOn = (
        candidate: number,
        attempt: number,
      ): Effect.Effect<never> =>
        server.serve(handler, { port: candidate }).pipe(
          Effect.andThen(Effect.never),
          Effect.catchCause((cause) => {
            if (
              options.strictPort === true ||
              candidate === 0 ||
              !isAddressInUse(cause)
            ) {
              return Effect.failCause(cause);
            }
            // a few neighbours, then whatever the OS has free
            const next = attempt < PORT_FALLBACK_ATTEMPTS ? candidate + 1 : 0;
            return Console.warn(
              `sandbox: port ${candidate} is in use by another process; trying ${next === 0 ? "an ephemeral port" : next} instead. Stop the other process, or pass strictPort to fail.`,
            ).pipe(Effect.andThen(serveOn(next, attempt + 1)));
          }),
          Effect.scoped,
        );
      return yield* serveOn(port, 0);
    }).pipe(
      Effect.provide(Workspace.fixed(options.root)),
      Effect.provide(
        BunHttpServer({
          hostname,
          // idle reaping OFF: `ptyRead` long-polls sit silent for ~7s
          idleTimeout: 0,
          onListen: ({ port }) =>
            Console.log(
              `sandbox serving ${options.root} at http://localhost:${port}`,
            ),
        }),
      ),
      Effect.provide(BunServices.layer),
      Effect.scoped,
    );
  });

/** Neighbouring ports tried before asking the OS for any free one. */
const PORT_FALLBACK_ATTEMPTS = 5;

/** Bun's listen failure carries `code: "EADDRINUSE"` on the thrown
 *  error (surfaced as a defect by the platform layer); the message
 *  check covers a wrapped rendering of the same. */
const isAddressInUse = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause) as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return (
    error?.code === "EADDRINUSE" ||
    (typeof error?.message === "string" &&
      (error.message.includes("EADDRINUSE") ||
        error.message.includes("Is port")))
  );
};
