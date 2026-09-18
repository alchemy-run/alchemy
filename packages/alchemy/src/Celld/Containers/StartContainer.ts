import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { makeFetchRpcStub } from "../../Rpc.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { requireDurableObjectHost } from "../../Workers/DurableObject.ts";
import { DurableObjectScope } from "../DurableObject.ts";
import { DurableObjectState } from "../DurableObjectState.ts";
import type {
  ContainerClass,
  ContainerDeclaration,
  ContainerInstance,
} from "./Container.ts";
import {
  ContainerError,
  fromNativeContainer,
  type ContainerClient,
  type ContainerStartupOptions,
} from "./Native.ts";

const locks = new WeakMap<object, ReturnType<typeof Semaphore.makeUnsafe>>();

/**
 * Attach the declaration to the current Durable Object class. Native state is
 * instance-bound (Celld v0.5 harness.js constructs Container(scope) on ctx),
 * but every start, probe, monitor, and exec runs in the calling event.
 * @internal
 */
export const startContainer = <Self, Shape extends object, Req>(
  declaration: ContainerClass<Self, Shape, Req>,
  options?: ContainerStartupOptions,
) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const scope = yield* DurableObjectScope;
      const host = yield* requireDurableObjectHost(scope.name, "Celld.Worker");
      const props = yield* declaration["~celld/Container/Source"];
      const container: ContainerDeclaration = {
        ...props,
        name: declaration["~celld/Container/Id"],
        className: scope.name,
      };
      yield* host.bind`container:${scope.name}:${container.name}`({
        containers: [container],
      });
    }
    const state = yield* DurableObjectState;
    const raw = fromNativeContainer(() => {
      if (!globalThis.__ALCHEMY_RUNTIME__)
        throw new Error("Celld containers can only be called at runtime");
      if (!state.container)
        throw new Error(
          "The Durable Object class has no published Celld container image",
        );
      return state.container;
    });
    const mutex = yield* Effect.sync(() => {
      let mutex = locks.get(state);
      if (!mutex) {
        mutex = Semaphore.makeUnsafe(1);
        locks.set(state, mutex);
      }
      return mutex;
    });
    const ensureRunning = Semaphore.withPermits(
      mutex,
      1,
    )(
      Effect.gen(function* () {
        if (!(yield* raw.running)) yield* raw.start(options);
      }),
    );
    const client: ContainerClient = {
      ...raw,
      getTcpPort: (port) =>
        Effect.gen(function* () {
          const fetcher = yield* raw.getTcpPort(port);
          yield* ensureRunning;
          yield* fetcher.fetch(HttpClientRequest.get("http://container/")).pipe(
            Effect.timeout("2 seconds"),
            Effect.mapError(
              (cause) =>
                new ContainerError({
                  message: `Container port ${port} is not ready`,
                  cause,
                }),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }),
          );
          return fetcher;
        }),
      exec: (command, execOptions) =>
        ensureRunning.pipe(Effect.andThen(raw.exec(command, execOptions))),
    };
    return makeFetchRpcStub<ContainerInstance<Shape>>({
      base: { ...client },
      fetch: (request) =>
        client.getTcpPort(3000).pipe(
          Effect.flatMap((port) => port.fetch(request)),
          Effect.provide(RuntimeContext.phantom),
        ),
    });
  });

/**
 * Bind an image to the current Durable Object without starting I/O at init.
 * Port access and exec start lazily; monitor is explicitly request-scoped.
 * Celld v0.5 reports running before Docker creation completes. Await
 * `getTcpPort(port)` readiness before the first `exec`; exec itself is not
 * retried. Portless images have no native startup-readiness signal.
 *
 * ### Attaching a Container
 * **Example:** Provide the class used by the Durable Object init
 * ```typescript
 * init.pipe(Effect.provide(Celld.Containers.layer(Tool, {
 *   entrypoint: ["sleep", "infinity"],
 * })));
 * ```
 *
 * @layer
 * @provides Tool
 * @product Celld
 */
export const layer = <Self, Shape extends object, Req>(
  declaration: ContainerClass<Self, Shape, Req>,
  options?: ContainerStartupOptions,
) =>
  Layer.effect(
    declaration["~celld/Container/Tag"],
    startContainer(declaration, options),
  );
