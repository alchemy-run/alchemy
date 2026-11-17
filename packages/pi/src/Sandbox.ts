import { Sandbox, type SandboxHandle } from "@alchemy.run/ai/Sandbox";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvError, type EnvTarget } from "./Env.ts";
import { openDaemon } from "./internal/daemon.ts";
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

const MachineTypeId = "~alchemy/Pi/Machine" as const;

/**
 * Tools run on this machine, in `cwd` or the conversation's own working
 * directory, in place of a sandbox. Needs Node or Bun (a Fly Machine, an
 * ECS task, a container).
 *
 * @layer
 * @provides AI.Sandbox
 */
export const LocalEnv = (options: { readonly cwd: string }): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    open: (target) =>
      Effect.tryPromise({
        try: async () => {
          const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
          const unsupported = () =>
            Effect.fail(
              new EnvError({
                operation: "exec",
                code: "unknown",
                message: "Pi.LocalEnv is this machine: use Pi.Env, not the sandbox handle",
              }),
            );
          // Pi reads the machine's own environment off the handle; no daemon runs.
          return {
            [MachineTypeId]: new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd }),
            exec: unsupported,
            start: unsupported,
          } as SandboxHandle;
        },
        catch: (cause) =>
          new EnvError({
            operation: "open",
            code: "unknown",
            message: `Pi.LocalEnv needs Node or Bun: ${String(cause)}`,
          }),
      }),
    remove: () => Effect.void,
  });

/**
 * Builds each tool call's Pi `ExecutionEnv` from the conversation's
 * sandbox: installs the daemon once per sandbox handle, then talks to it.
 *
 * @internal
 */
export const makeEnvFor = (sandboxes: Sandbox["Service"]) => {
  const installed = new WeakSet<object>();
  return (target: EnvTarget): Effect.Effect<ExecutionEnv, EnvError, RuntimeContext> =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxes.open({
        instanceId: target.instanceId,
        conversationId: String(target.conversationId),
        ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      });
      if (MachineTypeId in sandbox) return sandbox[MachineTypeId] as ExecutionEnv;
      if (!installed.has(sandbox)) {
        const result = yield* sandbox.exec(["sh", "-c", INSTALL]);
        if (result.exitCode !== 0) {
          return yield* new EnvError({
            operation: "open",
            code: "unknown",
            message: `pi-env install exited ${result.exitCode}`,
          });
        }
        installed.add(sandbox);
      }
      const run = Effect.runPromiseWith(yield* Effect.context<RuntimeContext>());
      const connection = new StreamConnection(
        openDaemon(sandbox, { daemon: DAEMON, dir: PI_ENV.dir }, run),
      );
      // The daemon reports its user's home, which differs between sandbox platforms.
      const cwd =
        target.cwd ?? (yield* Effect.tryPromise(async () => (await connection.info()).home));
      const { RemoteExecutionEnv } = yield* Effect.promise(() => import("@earendil-works/pi-env"));
      return new RemoteExecutionEnv({
        connection: connection as unknown as Connection,
        id: `alchemy-sandbox:${target.conversationId}`,
        cwd,
      }) as unknown as ExecutionEnv;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvError({
            operation: "open",
            code: "unknown",
            message: `Sandbox: ${messageOf(cause)}`,
          }),
      ),
    );
};
