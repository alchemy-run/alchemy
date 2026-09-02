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
   * Port to listen on. `0` asks the OS for a free one.
   * @default `PORT` from the environment, else `0`
   */
  readonly port?: number;
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
      yield* server.serve(
        serveRpc(
          { ...sandbox, ...pty },
          HttpServerResponse.json({ ok: true, root: options.root }),
        ),
        { port },
      );
      return yield* Effect.never;
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
