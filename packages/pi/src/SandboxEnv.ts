import type { EnvTarget } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Sandbox from "alchemy/Sandbox";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { EnvError, EnvHost } from "./Env.ts";
import { StreamConnection } from "./internal/pienv.ts";
import { messageOf } from "./internal/promise.ts";

/** pi-env, the daemon that serves Pi's file and shell operations inside the sandbox. */
const PI_ENV = {
  version: "1.5.0",
  tarball: "https://registry.npmjs.org/@earendil-works/pi-env/-/pi-env-1.5.0.tgz",
  sha512:
    "8bc39ca5361b6f2e7976b6096271489cde8e122b3050f0804928ec693d0a68b39e691509777858ab27e68cf32e61d97c7753bb7330f5991fdc0bf7389cfbf856",
  dir: "/tmp/alchemy-pi-env-1.5.0",
};
const DAEMON = `${PI_ENV.dir}/pi-env`;

/** Install the daemon once per sandbox: the npm tarball, checked against its integrity hash. */
const INSTALL = `set -e
if [ ! -x ${DAEMON} ]; then
  mkdir -p ${PI_ENV.dir}
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "pi-env: unsupported $(uname -m)" >&2; exit 1 ;; esac
  curl -fsSL ${PI_ENV.tarball} -o ${PI_ENV.dir}/pi-env.tgz
  echo "${PI_ENV.sha512}  ${PI_ENV.dir}/pi-env.tgz" | sha512sum -c - >/dev/null
  tar -xzf ${PI_ENV.dir}/pi-env.tgz -C ${PI_ENV.dir} package/bin/pi-env-linux-$arch/pi-env
  mv ${PI_ENV.dir}/package/bin/pi-env-linux-$arch/pi-env ${DAEMON}.tmp
  chmod +x ${DAEMON}.tmp
  mv ${DAEMON}.tmp ${DAEMON}
fi`;

/**
 * What a sandbox must offer to host a conversation's tools: commands to
 * completion, and a long-running process with stdin. Every Alchemy sandbox
 * handle (E2B, Daytona, Modal, Boat) has both.
 */
export type SandboxLike = Sandbox.SandboxExec<any, { readonly exitCode: number }, any> &
  Sandbox.SandboxProcesses<any, any>;

export interface SandboxEnvOptions {
  /** Where tools start when the conversation names no `cwd`. @default "/home/user" */
  readonly cwd?: string;
}

/**
 * Run a conversation's tools in a sandbox. `sandboxFor` finds or creates
 * the conversation's sandbox; make it idempotent (find by metadata first),
 * so the same conversation reaches the same sandbox after its Durable
 * Object is evicted. Pi's own `pi-env` daemon runs inside the sandbox, so
 * `read`, `write`, `edit` and `bash` behave exactly as they do locally.
 *
 * **Example:** One E2B sandbox per conversation
 * ```typescript
 * const SandboxEnvLive = Pi.SandboxEnv(
 *   Effect.gen(function* () {
 *     const sandboxes = yield* E2B.CreateSandbox(Workspace);
 *     return Effect.fn(function* ({ conversationId }) {
 *       const metadata = { conversation: String(conversationId) };
 *       const [existing] = yield* sandboxes.list({ metadata, state: ["running", "paused"] });
 *       return existing
 *         ? yield* sandboxes.connect(existing.sandboxID)
 *         : yield* sandboxes.create({ metadata, autoPause: true, timeout: 1800 });
 *     });
 *   }),
 * );
 * ```
 *
 * @layer
 * @provides Pi.EnvHost
 */
export const SandboxEnv = <R>(
  make: Effect.Effect<
    (target: EnvTarget) => Effect.Effect<SandboxLike, unknown, RuntimeContext>,
    never,
    R
  >,
  options: SandboxEnvOptions = {},
): Layer.Layer<EnvHost, never, Exclude<R, Scope.Scope>> =>
  Layer.effect(
    EnvHost,
    Effect.map(make, (sandboxFor) => {
      const installed = new WeakSet<object>();
      return {
        make: (target: EnvTarget) =>
          Effect.gen(function* () {
            const sandbox = yield* sandboxFor(target);
            if (!installed.has(sandbox)) {
              const result = yield* sandbox.exec(["sh", "-c", INSTALL]);
              if (result.exitCode !== 0) {
                return yield* Effect.fail(new Error(`pi-env install exited ${result.exitCode}`));
              }
              installed.add(sandbox);
            }
            const run = Effect.runPromiseWith(yield* Effect.context<RuntimeContext>());
            const connection = new StreamConnection(async (token, handlers) => {
              const scope = Scope.makeUnsafe();
              const process = await run(
                sandbox
                  .start([DAEMON, "serve", "--token", token], { stdin: true })
                  .pipe(Scope.provide(scope)),
              );
              void run(
                process.output.pipe(
                  Stream.runForEach((chunk) =>
                    Effect.sync(() => {
                      if (chunk.fd === "stdout") handlers.onData(chunk.data);
                    }),
                  ),
                  Effect.ensuring(Effect.sync(handlers.onClose)),
                  Effect.ignore,
                ),
              );
              // Writes go out in order: each waits for the one before.
              let last: Promise<unknown> = Promise.resolve();
              return {
                write: (bytes) => {
                  last = last.then(() => run(Effect.ignore(process.write(bytes))));
                },
                close: () => {
                  void last
                    .then(() => run(Effect.ignore(process.kill("SIGTERM"))))
                    .finally(() => run(Scope.close(scope, Exit.void)));
                },
              };
            });
            const { RemoteExecutionEnv } = yield* Effect.promise(
              () => import("@earendil-works/pi-env"),
            );
            return new RemoteExecutionEnv({
              connection: connection as unknown as Connection,
              id: `alchemy-sandbox:${target.conversationId}`,
              cwd: target.cwd ?? options.cwd ?? "/home/user",
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EnvError({
                  operation: "open",
                  code: "unknown",
                  message: `Sandbox: ${messageOf(cause)}`,
                }),
            ),
          ),
      };
    }),
  );
