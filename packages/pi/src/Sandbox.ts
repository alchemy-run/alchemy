import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvError, type EnvTarget } from "./Env.ts";
import { openDaemon, type DaemonSandbox } from "./internal/daemon.ts";
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
 * What a sandbox must offer to host a conversation's tools: commands run to
 * completion, and a background command whose output can be followed. Every
 * Alchemy sandbox handle (E2B, Daytona, Modal, Boat, Archil) has both.
 */
export type SandboxLike = DaemonSandbox;

const MachineTypeId = "~alchemy/Pi/Machine" as const;

/** The machine the harness itself runs on, in place of a sandbox (`Pi.LocalEnv`). */
export interface Machine {
  readonly [MachineTypeId]: ExecutionEnv;
}

/**
 * What a conversation's sandbox is keyed on. Conversation ids repeat from
 * one harness instance to the next, so the instance's id is part of the key.
 */
export type SandboxKey = Pick<EnvTarget, "instanceId" | "conversationId">;

/**
 * Where a conversation's files and shell are. `open` finds or creates the
 * conversation's sandbox, and `remove` deletes it. Make `open` idempotent
 * (find by name or metadata first), so the same conversation reaches the
 * same sandbox after its Durable Object is evicted. Conversation ids repeat
 * across Durable Objects, so key the sandbox on `instanceId` too.
 *
 * Pi's coding tools (`Pi.CodingTools`) require it: a harness that lists
 * them does not compile until a `Pi.Sandbox` Layer is provided. Pi's own
 * `pi-env` daemon runs inside the sandbox, so `read`, `write`, `edit` and
 * `bash` behave exactly as they do locally. Tools start in the
 * conversation's `cwd`, or in the sandbox user's home directory.
 *
 * The sandbox can be on any platform (E2B, Daytona, Modal, Boat, Archil):
 * changing platform is providing a different Layer. Its image needs `sh`,
 * `curl`, `tar`, `sha512sum`, `base64`, `dd` and `mkfifo`, and the sandbox
 * needs to reach `registry.npmjs.org` once, to install the daemon.
 *
 * **Example:** One E2B sandbox per conversation
 * ```typescript
 * const E2BSandbox = Layer.effect(
 *   Pi.Sandbox,
 *   Effect.gen(function* () {
 *     const base = yield* E2B.Template("Base", { image: "node:22-bookworm" });
 *     const sandboxes = yield* E2B.CreateSandbox(base);
 *     const find = ({ instanceId, conversationId }: Pi.SandboxKey) =>
 *       sandboxes.list({
 *         metadata: { instance: instanceId, conversation: String(conversationId) },
 *         state: ["running", "paused"],
 *       });
 *     return {
 *       open: Effect.fn(function* (target) {
 *         const [existing] = yield* find(target);
 *         return existing
 *           ? yield* sandboxes.connect(existing.sandboxID)
 *           : yield* sandboxes.create({
 *               metadata: {
 *                 instance: target.instanceId,
 *                 conversation: String(target.conversationId),
 *               },
 *               timeout: 600,
 *             });
 *       }),
 *       remove: Effect.fn(function* (key) {
 *         const found = yield* find(key);
 *         yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
 *       }),
 *     };
 *   }),
 * ).pipe(Layer.provide(E2B.CreateSandboxHttp));
 * ```
 *
 * **Example:** The same on Daytona
 * ```typescript
 * const DaytonaSandbox = Layer.effect(
 *   Pi.Sandbox,
 *   Effect.gen(function* () {
 *     const base = yield* Daytona.Snapshot("Base", { image: "node:22-bookworm" });
 *     const sandboxes = yield* Daytona.CreateSandbox(base);
 *     const nameOf = ({ instanceId, conversationId }: Pi.SandboxKey) =>
 *       `pi-${instanceId.slice(0, 16)}-${conversationId}`;
 *     return {
 *       open: Effect.fn(function* (target) {
 *         const existing = yield* sandboxes.get(nameOf(target));
 *         if (existing === undefined) {
 *           return yield* sandboxes.create({ name: nameOf(target), autoStopInterval: 15 });
 *         }
 *         yield* existing.startSandbox();
 *         return existing;
 *       }),
 *       remove: (key) => sandboxes.delete(nameOf(key)),
 *     };
 *   }),
 * ).pipe(Layer.provide(Daytona.CreateSandboxHttp));
 * ```
 *
 * **Example:** A harness whose coding tools run in the sandbox
 * ```typescript
 * const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools] });
 * // provided with:
 * const HarnessLive = Layer.mergeAll(FastLive, PiCloudflare.DurableObjectStorage, E2BSandbox);
 * ```
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Find or create the conversation's sandbox. */
    readonly open: (
      target: EnvTarget,
    ) => Effect.Effect<SandboxLike | Machine, unknown, RuntimeContext>;
    /** Delete the conversation's sandbox, if it has one. Its next tool call opens a new one. */
    readonly remove: (key: SandboxKey) => Effect.Effect<unknown, unknown, RuntimeContext>;
  }
>()("Pi.Sandbox") {}

/**
 * Tools run on this machine, in `cwd` or the conversation's own working
 * directory, in place of a sandbox. Needs Node or Bun (a Fly Machine, an
 * ECS task, a container).
 *
 * @layer
 * @provides Pi.Sandbox
 */
export const LocalEnv = (options: { readonly cwd: string }): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    open: (target) =>
      Effect.tryPromise({
        try: async (): Promise<Machine> => {
          const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
          return { [MachineTypeId]: new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd }) };
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
      const sandbox = yield* sandboxes.open(target);
      if (MachineTypeId in sandbox) return sandbox[MachineTypeId];
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
