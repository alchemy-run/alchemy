import type * as functions from "@distilled.cloud/modal/functions";
import { Platform, type Main, type MainRpc } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ContainerProps } from "./Container.ts";
import { seconds } from "./internal.ts";
import { ENTRYPOINT, RPC_SERVE_ENV } from "./internal/Entrypoint.ts";
import { createModalRuntimeContext, rpcMethodNamesOf } from "./internal/Rpc.ts";
import {
  resolveContainerProps,
  runtimeLifecycle,
  type RuntimeAttributes,
} from "./internal/Runtime.ts";
import type { MountContract } from "./Mounts.ts";
import type { Providers } from "./Providers.ts";
import type { DurationInput } from "./SandboxClient.ts";

/** Serve the function on the web at a `*.modal.run` URL. */
export interface WebEndpointOptions {
  /**
   * Label in the URL (`https://<workspace>--<label>.modal.run`).
   * @default "<app>-<function>"
   */
  label?: string;
  /**
   * Require Modal's proxy auth headers (`Modal-Key` / `Modal-Secret`, from a
   * `Modal.WebhookToken`) on every request.
   * @default false
   */
  requiresProxyAuth?: boolean;
  /** Custom domains (verified `Modal.Domain`s) that also serve the endpoint. */
  customDomains?: string[];
}

/** Run the function on a schedule: a cron expression, or a fixed period. */
export type FunctionSchedule =
  | {
      /** Cron expression (`"0 9 * * 1-5"`). */
      readonly cron: string;
      /** IANA time zone the expression is read in. @default "UTC" */
      readonly timezone?: string;
    }
  | {
      /** Time between runs (`"1 hour"`, or seconds). */
      readonly period: DurationInput;
    };

/** Retry failed calls. */
export interface FunctionRetries {
  /** Retries after the first failure. */
  readonly maxRetries: number;
  /** Delay multiplier per retry; `1` is a fixed delay. @default 2 */
  readonly backoffCoefficient?: number;
  /** Delay before the first retry. @default 1 second */
  readonly initialDelay?: DurationInput;
  /** Longest delay between retries, at most 60 seconds. @default 60 seconds */
  readonly maxDelay?: DurationInput;
}

export interface FunctionProps extends ContainerProps {
  /**
   * Serve the program's `fetch` handler on the web instead of taking calls.
   * The URL is the `url` attribute.
   */
  web?: boolean | WebEndpointOptions;
  /**
   * Run on a schedule. Each tick arrives at the program's `fetch` handler
   * as `POST /__modal/schedule`.
   */
  schedule?: FunctionSchedule;
  /** Retry failed calls: a count, or a backoff policy. Not for web functions. */
  retries?: number | FunctionRetries;
  /** Most inputs one container handles at once. @default 1 */
  maxConcurrentInputs?: number;
  /** Inputs per container the autoscaler aims for (at most `maxConcurrentInputs`). */
  targetConcurrentInputs?: number;
  /** Shut each container down after it handles one input. */
  singleUseContainers?: boolean;
}

export interface FunctionAttributes extends RuntimeAttributes {
  /** The web endpoint's URL, for a function with `web`. */
  url: string | undefined;
  /** The program's RPC methods, which `Modal.InvokeFunction` calls. */
  methods: string[];
}

/** A Function's program returns RPC methods and also asks for `web` or a `schedule`. */
export class FunctionRpcConflict extends Data.TaggedError("Modal.FunctionRpcConflict")<{
  readonly message: string;
}> {}

export type Function = Resource<
  "Modal.Function",
  FunctionProps,
  FunctionAttributes,
  { env?: Record<string, any>; mounts?: MountContract; rpcCallers?: string[] },
  Providers
>;

export type FunctionServices = ServerHost;
/**
 * What the program returns: `fetch` for HTTP, and any other functions,
 * its RPC methods.
 */
export type FunctionShape =
  | Main<FunctionServices>
  | (Exclude<Main<FunctionServices>, void> & MainRpc<FunctionServices>);
export type FunctionRuntimeContext = HostRuntimeContext;

/**
 * A Modal Function running your program: Modal scales its containers with
 * demand (to zero when idle), and the function takes calls, runs on a
 * schedule, or serves the web.
 *
 * Alchemy bundles `main`, builds it into an image on Modal's builder (no
 * Docker), and deploys the function into its `Modal.App`. Modal starts each
 * container with its Python entrypoint; Alchemy's entrypoint starts your
 * program and hands it work:
 *
 * - the program's RPC methods (every function it returns besides `fetch`)
 *   become the function's methods: `Modal.InvokeFunction` calls them with
 *   typed arguments and results, and Modal queues, retries and autoscales
 *   the calls;
 * - with `web`, Modal routes the function's `*.modal.run` URL to the
 *   program's `fetch` handler;
 * - a `schedule` tick arrives at `fetch` as `POST /__modal/schedule`.
 *
 * A function serves one of these. To serve methods next to `fetch`, use a
 * `Modal.Server`. The program's env, including the credentials its
 * bindings need, goes into a Modal Secret, never into the image.
 *
 * ### Effect program
 * **Example:** A function other runtimes call
 * ```typescript
 * // src/Embed.ts
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import { Inference } from "./Inference.ts";
 *
 * export default class Embed extends Modal.Function<Embed>()(
 *   "Embed",
 *   { main: import.meta.url, app: Inference },
 *   Effect.gen(function* () {
 *     return {
 *       embed: Effect.fn(function* (text: string) {
 *         return { tokens: text.split(/\s+/).length };
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Call it from a Cloudflare Worker
 * ```typescript
 * const embed = yield* Modal.InvokeFunction(Embed);
 * const { tokens } = yield* embed.embed("hello modal");
 * ```
 *
 * ### Async program
 * **Example:** A plain HTTP server, no Effect (it runs on Bun)
 * ```typescript
 * // src/Embed.ts
 * import * as Modal from "@alchemy.run/modal";
 * import { Inference } from "./Inference.ts";
 *
 * export const Embed = Modal.Function("Embed", {
 *   main: "./src/embed-server.ts",
 *   app: Inference,
 *   env: { MODEL: "small" },
 * });
 * export type EmbedEnv = Modal.InferEnv<typeof Embed>;
 * ```
 *
 * ```typescript
 * // src/embed-server.ts
 * import type { EmbedEnv } from "./Embed.ts";
 *
 * const env = process.env as unknown as EmbedEnv;
 *
 * Bun.serve({
 *   port: Number(process.env.PORT),
 *   async fetch(request) {
 *     const { args } = (await request.json()) as { args: [string] };
 *     return Response.json({ model: env.MODEL, tokens: args[0].split(/\s+/).length });
 *   },
 * });
 * ```
 *
 * ### Web endpoints
 * **Example:** Serve `fetch` at a `*.modal.run` URL
 * ```typescript
 * export default class Api extends Modal.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, app: Inference, web: true },
 *   Effect.gen(function* () {
 *     return { fetch: Effect.succeed(HttpServerResponse.text("hello from Modal")) };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Behind Modal's proxy auth
 * ```typescript
 * export default class Admin extends Modal.Function<Admin>()(
 *   "Admin",
 *   { main: import.meta.url, app: Inference, web: { requiresProxyAuth: true, label: "admin" } },
 *   program,
 * ) {}
 * ```
 *
 * ### Schedules
 * **Example:** Run every morning
 * ```typescript
 * export default class Digest extends Modal.Function<Digest>()(
 *   "Digest",
 *   { main: import.meta.url, app: Inference, schedule: { cron: "0 9 * * *", timezone: "Europe/London" } },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* Effect.log("sending the digest");
 *         return yield* HttpServerResponse.json(null);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### GPUs, volumes and scaling
 * **Example:** A warm GPU function reading weights from a volume
 * ```typescript
 * export default class Generate extends Modal.Function<Generate>()(
 *   "Generate",
 *   {
 *     main: import.meta.url,
 *     app: Inference,
 *     gpu: "L4",
 *     mounts: [{ volume: Weights, path: "/models" }],
 *     minContainers: 1,
 *     scaledownWindow: 300,
 *     maxConcurrentInputs: 8,
 *     timeout: "10 minutes",
 *   },
 *   program,
 * ) {}
 * ```
 *
 * @resource
 * @product Function
 */
export const Function: Platform<Function, FunctionServices, FunctionShape, FunctionRuntimeContext> =
  Platform("Modal.Function", {
    createRuntimeContext: createModalRuntimeContext("Modal.Function"),
    transformProps: resolveContainerProps,
  });

const bootstrapEntry =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/modal/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

const scheduleOf = (schedule: FunctionSchedule | undefined): functions.Schedule | undefined =>
  schedule === undefined
    ? undefined
    : "cron" in schedule
      ? { cron: { cronString: schedule.cron, timezone: schedule.timezone ?? "UTC" } }
      : { period: { seconds: seconds(schedule.period) } };

const retriesOf = (
  retries: number | FunctionRetries | undefined,
): functions.FunctionRetryPolicy | undefined =>
  retries === undefined
    ? undefined
    : typeof retries === "number"
      ? { retries, backoffCoefficient: 1, initialDelayMs: 1000, maxDelayMs: 60_000 }
      : {
          retries: retries.maxRetries,
          backoffCoefficient: retries.backoffCoefficient ?? 2,
          initialDelayMs: Math.round((seconds(retries.initialDelay) ?? 1) * 1000),
          maxDelayMs: Math.round((seconds(retries.maxDelay) ?? 60) * 1000),
        };

/** How a Function differs from the other runtimes: a call, schedule or web function. */
const definitionOf = (
  props: FunctionProps,
  context: { readonly port: number; readonly startupTimeout: number },
): functions.Function => {
  const methods = rpcMethodNamesOf(props.env);
  if (methods.length > 0) {
    // One method per RPC method: callers send its name as the input's
    // `method_name`, and the entrypoint's `Rpc` class forwards it to the
    // program's `/__rpc__/<method>`.
    const formats = ["DATA_FORMAT_PICKLE", "DATA_FORMAT_CBOR"];
    return {
      implementationName: ENTRYPOINT.rpc,
      isClass: true,
      methodDefinitions: Object.fromEntries(
        methods.map((name) => [
          name,
          {
            functionName: name,
            functionType: "FUNCTION_TYPE_FUNCTION",
            supportedInputFormats: formats,
            supportedOutputFormats: formats,
          },
        ]),
      ),
      supportedInputFormats: formats,
      supportedOutputFormats: formats,
      retryPolicy: retriesOf(props.retries),
      maxConcurrentInputs: props.maxConcurrentInputs ?? 0,
      targetConcurrentInputs: props.targetConcurrentInputs ?? 0,
      singleUseContainers: props.singleUseContainers,
      maxInputs: props.singleUseContainers ? 1 : 0,
    };
  }
  if (props.web) {
    const web = props.web === true ? {} : props.web;
    return {
      implementationName: ENTRYPOINT.web,
      webhookConfig: {
        type: "WEBHOOK_TYPE_WEB_SERVER",
        webServerPort: context.port,
        webServerStartupTimeout: context.startupTimeout,
        requestedSuffix: web.label,
        requiresProxyAuth: web.requiresProxyAuth,
        customDomains: web.customDomains?.map((name) => ({ name })),
      },
      supportedInputFormats: ["DATA_FORMAT_ASGI"],
      supportedOutputFormats: ["DATA_FORMAT_ASGI", "DATA_FORMAT_GENERATOR_DONE"],
      schedule: scheduleOf(props.schedule),
      maxConcurrentInputs: props.maxConcurrentInputs ?? 0,
      targetConcurrentInputs: props.targetConcurrentInputs ?? 0,
      singleUseContainers: props.singleUseContainers,
      maxInputs: props.singleUseContainers ? 1 : 0,
    };
  }
  return {
    implementationName: props.schedule ? ENTRYPOINT.schedule : ENTRYPOINT.call,
    supportedInputFormats: ["DATA_FORMAT_PICKLE", "DATA_FORMAT_CBOR"],
    supportedOutputFormats: ["DATA_FORMAT_PICKLE", "DATA_FORMAT_CBOR"],
    schedule: scheduleOf(props.schedule),
    retryPolicy: retriesOf(props.retries),
    maxConcurrentInputs: props.maxConcurrentInputs ?? 0,
    targetConcurrentInputs: props.targetConcurrentInputs ?? 0,
    singleUseContainers: props.singleUseContainers,
    maxInputs: props.singleUseContainers ? 1 : 0,
  };
};

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const lifecycle = yield* runtimeLifecycle<FunctionProps>({
        type: "Modal.Function",
        definition: definitionOf,
        bootstrap: bootstrapEntry,
        // Modal authenticates every call of a class function, so its
        // program serves RPC (see `createModalRuntimeContext`).
        env: (props): Record<string, string> =>
          rpcMethodNamesOf(props.env).length > 0 ? { [RPC_SERVE_ENV]: "1" } : {},
      });
      return {
        stables: lifecycle.stables,
        diff: lifecycle.diff,
        read: Effect.fn(function* ({ output }) {
          const found = yield* lifecycle.read({ output });
          return found === undefined ? undefined : (output as FunctionAttributes);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
          const methods = rpcMethodNamesOf(news.env);
          if (methods.length > 0 && (news.web || news.schedule)) {
            return yield* new FunctionRpcConflict({
              message: `${id} returns RPC methods (${methods.join(", ")}) and sets ${news.web ? "web" : "schedule"}: a Modal.Function serves calls to its methods, a web endpoint or a schedule. Serve methods next to fetch with a Modal.Server.`,
            });
          }
          const { attributes, metadata } = yield* lifecycle.reconcile({
            id,
            news,
            output,
            session,
            bindings,
          });
          return { ...attributes, url: news.web ? metadata?.webUrl : undefined, methods };
        }),
        delete: lifecycle.delete,
      };
    }),
  );
