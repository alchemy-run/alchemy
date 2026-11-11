import * as functions from "@distilled.cloud/modal/functions";
import { Platform, type Main, type MainRpc } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ContainerProps } from "./Container.ts";
import { environmentOf, seconds } from "./internal.ts";
import { ENTRYPOINT, RPC_SERVE_ENV } from "./internal/Entrypoint.ts";
import { createModalRuntimeContext } from "./internal/Rpc.ts";
import {
  resolveContainerProps,
  runtimeLifecycle,
  type RuntimeAttributes,
} from "./internal/Runtime.ts";
import type { MountContract } from "./Mounts.ts";
import type { Providers } from "./Providers.ts";
import type { DurationInput } from "./SandboxClient.ts";

export interface ServerProps extends ContainerProps {
  /**
   * Region requests are routed through (`"us-east"`, `"us-west"`, `"eu-west"`,
   * `"ap-south"`, ...). Containers run near it.
   * @default "us-east"
   */
  routingRegion?: string;
  /**
   * Serve without Modal's proxy auth. By default every request needs the
   * `Modal-Key` / `Modal-Secret` headers of a `Modal.WebhookToken`.
   * @default false
   */
  unauthenticated?: boolean;
  /** Serve HTTP/2 to the program. */
  h2?: boolean;
  /**
   * Time in-flight requests get to finish when a container shuts down, at
   * most an hour.
   * @default 0
   */
  exitGracePeriod?: DurationInput;
  /**
   * Concurrent requests per container the autoscaler aims for; may be
   * fractional (`1.5`). `0` turns autoscaling off.
   */
  targetConcurrency?: number;
  /**
   * Most concurrent requests per container; more get `429`.
   * @default unlimited
   */
  maxConcurrency?: number;
  /**
   * Sticky sessions: each session is pinned to one container
   * (`server.sessions.start()` in Modal's clients).
   * @default false
   */
  sessioned?: boolean;
}

export interface ServerAttributes extends RuntimeAttributes {
  /** The Server's URL. */
  url: string | undefined;
  /** Region requests are routed through. */
  routingRegion: string;
  /** Whether requests skip Modal's proxy auth. */
  unauthenticated: boolean;
}

export type Server = Resource<
  "Modal.Server",
  ServerProps,
  ServerAttributes,
  { env?: Record<string, any>; mounts?: MountContract; rpcCallers?: string[] },
  Providers
>;

export type ServerServices = ServerHost;
/**
 * What the program returns: `fetch` for HTTP, and any other functions,
 * its RPC methods.
 */
export type ServerShape =
  | Main<ServerServices>
  | (Exclude<Main<ServerServices>, void> & MainRpc<ServerServices>);
export type ServerRuntimeContext = HostRuntimeContext;

/**
 * A Modal Server: your program as a long-running HTTP server on Modal, with
 * low-latency routing through one region and autoscaling on concurrent
 * requests. Use it for APIs, model servers and anything that keeps
 * connections open; use `Modal.Function` with `web` for simple endpoints.
 *
 * Alchemy bundles `main`, builds it into an image on Modal's builder (no
 * Docker) and deploys the Server into its `Modal.App`. Each container starts
 * the program, and Modal routes the Server's URL to its `fetch` handler.
 * Requests need Modal's proxy auth headers unless `unauthenticated` is set:
 * bind `Modal.FetchServer(server)` to call it from another runtime.
 *
 * ### Effect program
 * **Example:** An API server
 * ```typescript
 * // src/Api.ts
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Backend } from "./Backend.ts";
 *
 * export default class Api extends Modal.Server<Api>()(
 *   "Api",
 *   { main: import.meta.url, app: Backend, routingRegion: "us-east" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async program
 * **Example:** A plain HTTP server, no Effect (it runs on Bun)
 * ```typescript
 * // src/Api.ts
 * import * as Modal from "@alchemy.run/modal";
 * import { Backend } from "./Backend.ts";
 *
 * export const Api = Modal.Server("Api", {
 *   main: "./src/api-server.ts",
 *   app: Backend,
 *   unauthenticated: true,
 *   env: { GREETING: "hello" },
 * });
 * export type ApiEnv = Modal.InferEnv<typeof Api>;
 * ```
 *
 * ```typescript
 * // src/api-server.ts
 * import type { ApiEnv } from "./Api.ts";
 *
 * const env = process.env as unknown as ApiEnv;
 *
 * Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(env.GREETING) });
 * ```
 *
 * ### Calling it
 * **Example:** From a Cloudflare Worker, with proxy auth
 * ```typescript
 * const api = yield* Modal.FetchServer(Api);
 * const response = yield* api.fetch(HttpClientRequest.get("/"));
 * ```
 *
 * ### Scaling
 * **Example:** Two warm containers, 20 requests each
 * ```typescript
 * export default class Api extends Modal.Server<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     app: Backend,
 *     minContainers: 2,
 *     targetConcurrency: 20,
 *     maxConcurrency: 50,
 *     exitGracePeriod: "30 seconds",
 *   },
 *   program,
 * ) {}
 * ```
 *
 * @resource
 * @product Server
 */
export const Server: Platform<Server, ServerServices, ServerShape, ServerRuntimeContext> = Platform(
  "Modal.Server",
  {
    createRuntimeContext: createModalRuntimeContext("Modal.Server"),
    transformProps: resolveContainerProps,
  },
);

const bootstrapEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/modal/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

const DEFAULT_REGION = "us-east";

const definitionOf = (
  props: ServerProps,
  context: { readonly port: number; readonly startupTimeout: number },
): functions.Function => {
  const region = props.routingRegion ?? DEFAULT_REGION;
  return {
    implementationName: ENTRYPOINT.server,
    isServer: true,
    isSessioned: props.sessioned ?? false,
    routingRegion: region,
    httpConfig: {
      port: context.port,
      proxyRegions: [region],
      startupTimeout: Math.round(context.startupTimeout),
      exitGracePeriod: Math.round(seconds(props.exitGracePeriod) ?? 0),
      h2Enabled: props.h2 ?? false,
      unauthenticated: props.unauthenticated ?? false,
    },
    maxConcurrentInputs: props.maxConcurrency ?? 0,
    supportedInputFormats: [],
    supportedOutputFormats: [],
  };
};

export const ServerProvider = () =>
  Provider.effect(
    Server,
    Effect.gen(function* () {
      const lifecycle = yield* runtimeLifecycle<ServerProps>({
        type: "Modal.Server",
        definition: (props, context) => {
          const definition = definitionOf(props, context);
          return props.targetConcurrency === undefined
            ? definition
            : {
                ...definition,
                autoscalerSettings: { targetConcurrencyFloat: props.targetConcurrency },
              };
        },
        bootstrap: bootstrapEntry,
        // Behind proxy auth Modal authenticates every request, so the
        // program serves RPC; an unauthenticated Server never does.
        env: (props): Record<string, string> =>
          props.unauthenticated ? {} : { [RPC_SERVE_ENV]: "1" },
      });

      /** The Server's URL: Modal assigns it once the App is published. */
      const urlOf = Effect.fn(function* (
        attributes: RuntimeAttributes,
        published: ReadonlyArray<string> | undefined,
      ) {
        if (published?.[0]) return published[0];
        const found = yield* functions
          .getFunction({
            appName: attributes.appName ?? "",
            objectTag: attributes.name,
            environmentName: environmentOf(attributes.environment),
          })
          .pipe(
            Effect.map((response) => response.handleMetadata?.ExperimentalFlashUrls?.[0]),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (url) => url !== undefined,
              times: 10,
            }),
          );
        return found;
      });

      return {
        stables: lifecycle.stables,
        diff: lifecycle.diff,
        read: Effect.fn(function* ({ output }) {
          const found = yield* lifecycle.read({ output });
          return found === undefined ? undefined : (output as ServerAttributes);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
          const { attributes, metadata } = yield* lifecycle.reconcile({
            id,
            news,
            output,
            session,
            bindings,
          });
          return {
            ...attributes,
            url: yield* urlOf(attributes, metadata?.ExperimentalFlashUrls),
            routingRegion: news.routingRegion ?? DEFAULT_REGION,
            unauthenticated: news.unauthenticated ?? false,
          };
        }),
        delete: lifecycle.delete,
      };
    }),
  );
