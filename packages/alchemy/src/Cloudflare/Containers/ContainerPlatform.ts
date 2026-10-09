import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import { serveRpc } from "../../Rpc.ts";
import { packEnvValueKeepRedacted, unpackEnvValue } from "../../RuntimeContext.ts";
import type { ProcessContext } from "../../Server/Process.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { Worker } from "../Workers/Worker.ts";
import { ContainerTypeId, type Container } from "./Container.ts";
import type {
  ContainerApplication,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";
import { workerContainerBinding } from "./ContainerConfiguration.ts";

const toHttpUrl = (url: string) =>
  url.startsWith("https:") ? `http:${url.slice("https:".length)}` : url;

/**
 * workerd container ports reject TLS outright ("Connecting to a container
 * using HTTPS is not currently supported") — but the common proxy pattern
 * forwards the incoming Worker request, whose production URL is `https://`,
 * straight to the port. The hop into the container is already secure, so
 * downgrade the scheme before forwarding, exactly like Cloudflare's own
 * `@cloudflare/containers` `containerFetch` does
 * (`request.url.replace("https:", "http:")`).
 */
export const httpSchemePort = <
  P extends {
    fetch: (...args: any[]) => any;
    connect: (...args: any[]) => any;
  },
>(
  port: P,
): P =>
  ({
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      input instanceof Request
        ? port.fetch(toHttpUrl(input.url), input)
        : port.fetch(toHttpUrl(String(input)), init),
    connect: (address: any, options?: any) => port.connect(address, options),
  }) as any as P;

const bindContainer = Effect.fn(function* <Shape, Req = never>(
  containerEff:
    | ContainerApplication<Shape>
    | Effect.Effect<ContainerApplication<Shape>, never, Req>,
) {
  const namespace = yield* DurableObject;

  const container = Effect.isEffect(containerEff) ? yield* containerEff : containerEff;

  yield* container.bind`${namespace}`({
    durableObjects: {
      namespaceId: namespace.namespaceId,
    },
  });

  const worker = yield* Worker;

  yield* worker.bind`${container.LogicalId}`({
    containers: [workerContainerBinding(namespace.name, container)],
  });
});

export const ContainerPlatform: Platform<
  ContainerApplication,
  ContainerServices,
  ContainerShape,
  ProcessContext,
  Container
> & { bind: typeof bindContainer } = Platform(
  "Cloudflare.Container",
  {
    createRuntimeContext: (id: string): ProcessContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      const serve = <Req = never>(
        handler: HttpEffect<Req>,
        options?: { shape?: Record<string, unknown> },
      ) =>
        Effect.sync(() => {
          // Containers have no native RPC transport (unlike a Cloudflare
          // Worker's JSRPC), so expose the impl's non-`fetch` shape methods
          // over the plain-`fetch` RPC protocol: requests to `/__rpc__/*` are
          // dispatched to the matching shape method, everything else falls
          // through to the user's `fetch` handler. The DO side talks to this
          // via `makeFetchRpcStub` over the container's TCP port.
          const finalHandler = options?.shape ? serveRpc(options.shape, handler) : handler;
          runners.push(
            Effect.gen(function* () {
              const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (httpServer) {
                yield* httpServer.serve(finalHandler);
                return yield* Effect.never;
              } else {
                // this should only happen at plantime, validate?
              }
            }).pipe(Effect.orDie),
          );
        });

      return {
        Type: ContainerTypeId,
        LogicalId: id,
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            // `packEnvValueKeepRedacted` keeps the Redacted wrapper on the
            // outside so the provider can deploy secrets through the
            // Secrets Store (referenced via `secrets`) instead of leaking
            // them as plain `environmentVariables`, while the inner marker
            // lets the runtime `get` accessor rebuild the wrapper after
            // Cloudflare hands the value back as a plain env-var string.
            // Mirrors `makeWorkerRuntimeContext`.
            env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
            return key;
          }),
        get: <T>(key: string) =>
          // Read straight from `process.env` — see `unpackEnvValue` for why
          // this must never resolve through `Config.String`.
          Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
        run: ((effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          })) as unknown as ProcessContext["run"],
        serve,
        exports: Effect.sync(() => ({
          default: Effect.all(
            runners.map((eff) =>
              Effect.forever(
                eff.pipe(
                  // Log and ignore errors (daemon mode, it should just re-run)
                  Effect.tapError((err) => Effect.logError(err)),
                  Effect.ignore,
                  // TODO(sam): ignore cause? for now, let that actually kill the server
                  // Effect.ignoreCause
                ),
              ),
            ),
            {
              concurrency: "unbounded",
            },
          ),
        })),
      } as ProcessContext;
    },
  },
  {
    bind: bindContainer,
  },
);
