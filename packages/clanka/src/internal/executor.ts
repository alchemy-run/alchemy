/**
 * clanka's executor in a sandbox: the program that serves it, how it is
 * installed, and the `AgentExecutor` Layer that reaches it.
 *
 * @internal
 * @module
 */
import { SandboxError, type SandboxHandle } from "@alchemy.run/ai/Sandbox";
import { openProcess } from "@alchemy.run/ai/SandboxProcess";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { AgentExecutor } from "clanka";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

/** The clanka release the harness is built against: the executor in the sandbox must speak the same protocol. */
export const CLANKA_VERSION = "0.28.3";
const EFFECT_VERSION = "4.1.4";

/** In the user's home, so a snapshot keeps it; `$HOME` is expanded by the sandbox's shell. */
const DIR = `"$HOME"/.alchemy-clanka-${CLANKA_VERSION}`;

/**
 * Serves clanka's executor over stdin and stdout. Nothing else may write
 * to stdout, so logs go to stderr.
 */
const SERVER = `import { AgentExecutor } from "clanka";
import { NodeHttpClient, NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

const directory = process.argv[2];
const excludeTools = process.argv.slice(3);

AgentExecutor.layerRpcServer({ directory, excludeTools }).pipe(
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeStdio.layer, NodeHttpClient.layerUndici)),
  Layer.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
  Layer.launch,
  NodeRuntime.runMain({ disablePrettyLogger: true }),
);
`;

/**
 * Install clanka once per sandbox; a snapshot that already holds the
 * directory skips it. One install runs at a time: a prompt started again
 * after an eviction can arrive while the first one's install is still
 * running. The server is written every time, so a snapshot built by an
 * older release of this package serves the current one.
 */
const INSTALL = `set -e
mkdir -p ${DIR}
cd ${DIR}
waited=0
while ! mkdir lock 2>/dev/null; do
  [ $waited -lt 180 ] || break
  sleep 1
  waited=$((waited + 1))
done
trap 'rmdir lock 2>/dev/null || true' EXIT
if [ ! -f ready ]; then
  printf '%s' '{"name":"alchemy-clanka","private":true,"type":"module"}' >package.json
  npm install --no-audit --no-fund --omit=optional --loglevel=error \\
    clanka@${CLANKA_VERSION} effect@${EFFECT_VERSION} @effect/platform-node@${EFFECT_VERSION} \\
    @effect/ai-openai@${EFFECT_VERSION} @effect/ai-openai-compat@${EFFECT_VERSION} >&2
  touch ready
fi
printf '%s' "$0" | base64 -d >server.mjs`;

/**
 * What a snapshot can run to hold clanka already, so a conversation's
 * first prompt does not install it.
 */
export const installCommand = `sh -c '${INSTALL.replaceAll("'", `'\\''`)}' ${btoa(SERVER)}`;

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

/**
 * clanka's `AgentExecutor`, running in `sandbox`, working in `directory`.
 * It is started for the scope and stopped when the scope closes.
 */
export const layerSandbox = (
  sandbox: SandboxHandle,
  options: {
    readonly directory: string;
    readonly excludeTools: ReadonlyArray<string>;
    /** Names the process's input pipe: unique among the sandbox's live executors. */
    readonly id: string;
  },
): Layer.Layer<AgentExecutor.AgentExecutor, SandboxError, RuntimeContext> =>
  AgentExecutor.layerRpc.pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      Layer.effect(
        Socket.Socket,
        Effect.gen(function* () {
          const installed = yield* sandbox.exec(["sh", "-c", INSTALL, btoa(SERVER)]).pipe(
            Effect.mapError(
              (cause) =>
                new SandboxError({
                  operation: "install",
                  code: "unknown",
                  message: messageOf(cause),
                }),
            ),
          );
          if (installed.exitCode !== 0) {
            return yield* new SandboxError({
              operation: "install",
              code: "unknown",
              message: `clanka could not be installed in the sandbox (it needs Node and npm): ${(installed.stderr ?? installed.result ?? "").slice(-2000)}`,
            });
          }
          yield* sandbox.exec(["mkdir", "-p", options.directory]).pipe(Effect.ignore);
          const process = yield* openProcess(sandbox, {
            fifo: `/tmp/alchemy-clanka-in.${options.id}`,
            command: [
              "sh",
              "-c",
              `exec node ${DIR}/server.mjs "$@"`,
              "clanka",
              options.directory,
              ...options.excludeTools,
            ],
          });
          const run = Effect.runPromiseWith(yield* Effect.context<never>());
          return yield* Socket.fromTransformStream(
            Effect.succeed({
              // The executor serves until it is stopped: an end is a crash, and stderr says why.
              readable: Stream.toReadableStream(
                process.output.pipe(
                  Stream.concat(
                    Stream.unwrap(
                      Effect.map(process.errors, (errors) =>
                        Stream.fail(
                          new SandboxError({
                            operation: "serve",
                            code: "unknown",
                            message: `clanka's executor exited: ${errors.trim() || "no error output"}`,
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              writable: new WritableStream<Uint8Array>({
                write: (bytes) => run(process.write(bytes)),
              }),
            }),
          );
        }),
      ),
    ),
  );
