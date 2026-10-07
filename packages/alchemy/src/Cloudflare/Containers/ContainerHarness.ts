import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Harness } from "../../AI/Session.ts";
import { connectHarness } from "../../AI/SessionRpcs.ts";
import { toHttpClient } from "../Fetcher.ts";
import type { Container, ContainerStartupOptions } from "./Container.ts";
import { layer as containerLayer } from "./StartContainer.ts";

/**
 * Provides `AI.Harness` from a container: each Durable Object instance (one
 * per session) owns one instance of `container`, whose program serves the
 * harness (`AI.serveHarnessHttp`) on `port`. Calls connect to it on demand —
 * never while the Durable Object is being constructed.
 *
 * ### Running sessions in containers
 * **Example:** A Durable Object per session, a container per Durable Object
 * ```typescript
 * export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
 *   "Agent",
 *   { schema: AI.SessionRpcs },
 *   Effect.gen(function* () {
 *     const harness = yield* AI.Harness;
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.sync(() => AI.makeSessionHandlers({ id: state.id.name!, harness }));
 *   }).pipe(Effect.provide(Cloudflare.ContainerHarness(Sandbox))),
 * ) {}
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const ContainerHarness = <C extends Container.Decl.Any>(
  container: C,
  options: ContainerStartupOptions & { readonly port?: number } = { enableInternet: true },
): Layer.Layer<Harness> =>
  Layer.effect(
    Harness,
    Effect.gen(function* () {
      const instance = (yield* container as unknown as Effect.Effect<Container>) as Container;
      return instance
        .getTcpPort(options.port ?? 3000)
        .pipe(Effect.flatMap((port) => connectHarness(toHttpClient(port))));
    }),
  ).pipe(
    Layer.provide(containerLayer(container, options) as Layer.Layer<never>),
  ) as Layer.Layer<Harness>;
