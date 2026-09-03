import type { Input } from "../../Input.ts";
import type { Worker } from "./Worker.ts";

type WorkerEntrypointTypeId = "Cloudflare.WorkerEntrypoint";
const WorkerEntrypointTypeId: WorkerEntrypointTypeId =
  "Cloudflare.WorkerEntrypoint";

export interface WorkerEntrypointOptions {
  /**
   * Named entrypoint on the target Worker — the exported
   * `WorkerEntrypoint` class the binding calls. Omitted → the default
   * entrypoint (equivalent to binding the Worker directly, but with
   * {@link props} support).
   */
  entrypoint?: string;
  /**
   * Properties exposed to the target entrypoint via workerd's
   * `ctx.props`. Values accept `Output` references and resolve at deploy
   * time.
   *
   * Local dev (`alchemy dev`) delivers these today. On deployed Workers
   * the Cloudflare API's binding schema does not carry `props` yet, so
   * they are typed and plumbed but dropped at upload until the distilled
   * `workers` service adds the field.
   */
  props?: Record<string, Input<unknown>>;
}

/**
 * A service binding to a specific entrypoint of another Worker — the value
 * form accepted in an async Worker's `env`. See {@link WorkerEntrypoint}.
 */
export interface WorkerEntrypointBinding<
  Entrypoint = undefined,
  Target extends Worker = Worker,
> {
  /** Brand discriminating entrypoint bindings in `env` classification. */
  readonly kind: WorkerEntrypointTypeId;
  /** The target Worker resource. */
  readonly worker: Target;
  /** Named entrypoint on the target, or `undefined` for the default. */
  readonly entrypoint: string | undefined;
  /** `ctx.props` delivered to the target entrypoint. */
  readonly props: Record<string, Input<unknown>> | undefined;
  /**
   * Phantom carrier of the target entrypoint class's type — never present
   * at runtime. `InferEnv` reads it to type `env.NAME` as that class's RPC
   * surface instead of a bare `Fetcher`.
   */
  readonly "~alchemy/entrypoint"?: Entrypoint;
}

/**
 * Bind a specific `WorkerEntrypoint` class exported by another Worker.
 *
 * Binding a Worker directly in `env` (`env: { TARGET: worker }`) targets
 * its *default* entrypoint. A Worker that exposes additional
 * `WorkerEntrypoint` classes — workerd treats every named class export of
 * an entry module as an entrypoint — is bound with `WorkerEntrypoint`,
 * which selects the class by name and can deliver `ctx.props` to it.
 *
 *
 * ### Binding a Named Entrypoint
 * The target Worker exports a `WorkerEntrypoint` class alongside its
 * default handler; the consumer selects it by name. Pass the class as a
 * type argument and `InferEnv` types the binding as that class's RPC
 * surface (`Service<typeof Api>`) rather than a bare `Fetcher` — the
 * entrypoint name is a runtime string, so nothing links it to the target
 * module's exports on its own.
 *
 * **Example:** Bind and call a named entrypoint
 * ```typescript
 * // target/src/worker.ts
 * import { WorkerEntrypoint } from "cloudflare:workers";
 *
 * export class Api extends WorkerEntrypoint {
 *   async greet(name: string): Promise<string> {
 *     return `hello ${name}`;
 *   }
 * }
 *
 * export default { async fetch() { return new Response("ok"); } };
 * ```
 *
 * ```typescript
 * // alchemy.run.ts
 * import type { Api } from "./target/src/worker.ts";
 *
 * const target = yield* Cloudflare.Worker("Target", { main: "./target/src/worker.ts" });
 *
 * const caller = yield* Cloudflare.Worker("Caller", {
 *   main: "./caller/src/worker.ts",
 *   env: {
 *     API: Cloudflare.WorkerEntrypoint<typeof Api>(target, "Api"),
 *   },
 * });
 * ```
 *
 * ```typescript
 * // caller/src/worker.ts
 * import type { CallerEnv } from "../../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: CallerEnv) {
 *     return new Response(await env.API.greet("alice"));
 *   },
 * };
 * ```
 *
 * ### Delivering ctx.props
 * The options form attaches properties the target reads from
 * `this.ctx.props` — workerd's per-binding configuration channel. `Output`
 * values resolve at deploy time.
 *
 * **Example:** Entrypoint binding with props
 * ```typescript
 * env: {
 *   VENDOR: Cloudflare.WorkerEntrypoint(vendorWorker, {
 *     entrypoint: "Vendor",
 *     props: { baseUrl: site.url },
 *   }),
 * }
 * ```
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const WorkerEntrypoint = <
  Entrypoint = undefined,
  Target extends Worker = Worker,
>(
  worker: Target,
  entrypointOrOptions?: string | WorkerEntrypointOptions,
): WorkerEntrypointBinding<Entrypoint, Target> => {
  const options =
    typeof entrypointOrOptions === "string"
      ? { entrypoint: entrypointOrOptions }
      : (entrypointOrOptions ?? {});
  return {
    kind: WorkerEntrypointTypeId,
    worker,
    entrypoint: options.entrypoint,
    props: options.props,
  };
};

/** Structural guard for {@link WorkerEntrypointBinding} `env` values. */
export const isWorkerEntrypoint = (
  value: unknown,
): value is WorkerEntrypointBinding<any, any> =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === WorkerEntrypointTypeId;
