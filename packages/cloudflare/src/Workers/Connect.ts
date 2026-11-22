import type * as runtime from "@cloudflare/workers-types";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  fromCloudflareSocket,
  type SocketAddress,
  type SocketOptions,
  type TcpSocket,
} from "../Fetcher.ts";
import { isWorker, type Worker, WorkerEnvironment } from "./Worker.ts";

/**
 * Open TCP connections to another Worker's `connect` handler over a service
 * binding. The TCP sibling of `Cloudflare.Workers.Fetch`.
 *
 * `Connect(worker)` registers the service binding at deploy time and returns
 * a function that opens one connection per call. The address is delivered to
 * the target as the socket's `localAddress`; the target decides what it
 * means.
 *
 * ### Connecting to a Worker
 * **Example:** Send a line to a TCP Worker and read the reply
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import EchoWorker from "./echo.ts";
 *
 * export default class Client extends Cloudflare.Worker<Client>()(
 *   "Client",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const echo = yield* Cloudflare.Workers.Connect(EchoWorker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const socket = yield* echo("echo.internal:7");
 *         const { pull } = yield* socket.reader;
 *         const writer = yield* socket.writer;
 *         yield* writer.write("ping\n");
 *         const reply = yield* pull;
 *         return HttpServerResponse.text(`${reply.length} chunk(s) back`);
 *       }).pipe(Effect.scoped, Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.ConnectBinding)),
 * ) {}
 * ```
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export interface Connect extends Binding.Service<
  Connect,
  "Cloudflare.Workers.Connect",
  (
    worker: Worker,
  ) => Effect.Effect<
    (
      address: SocketAddress | string,
      options?: SocketOptions,
    ) => Effect.Effect<TcpSocket, never, RuntimeContext>
  >
> {}

export const Connect = Binding.Service<Connect>("Cloudflare.Workers.Connect");

/**
 * {@link Connect} over a native service binding.
 *
 * @layer
 * @provides Cloudflare.Workers.Connect
 * @product Workers
 */
export const ConnectBinding = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (worker: Worker) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Deploy-time only: register the service binding for the target
        // Worker on the host Worker.
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          yield* host.bind`${worker}`({
            bindings: [
              {
                type: "service",
                name: worker.LogicalId,
                service: worker.workerName,
              },
            ],
          });
        }
      }
      // Lazy — the `WorkerEnvironment` bindings are only populated at exec
      // phase, so the fetcher must be resolved per call, not at bind time.
      return (address: SocketAddress | string, options?: SocketOptions) =>
        Effect.sync(() =>
          fromCloudflareSocket(
            (env as Record<string, runtime.Fetcher>)[worker.LogicalId]!.connect(address, options),
          ),
        ) as Effect.Effect<TcpSocket, never, RuntimeContext>;
    });
  }),
);
