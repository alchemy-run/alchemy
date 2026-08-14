import type { Credentials } from "@distilled.cloud/vercel/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { Unowned } from "../../AdoptPolicy.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved } from "../../Diff.ts";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import type { Resource, ResourceBinding } from "../../Resource.ts";
import * as crypto from "node:crypto";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Self as SelfService } from "../../Self.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import { sha256 } from "../../Util/sha256.ts";
import {
  fromBuildOutputDir,
  fromFunctionBundle,
  type BuildOutputRoute,
  type CronEntry,
  type QueueTriggerEntry,
  type VcConfig,
} from "../Deploy/BuildOutput.ts";
import {
  ALCHEMY_META_KEY,
  deleteAliasByIdOrName,
  deleteDeploymentById,
  deleteProjectByIdOrName,
  deployArtifact,
  ensureProject,
  ensureProtectionBypass,
  ensureStageAlias,
  findAutomationBypassSecret,
  findDeploymentByContentHash,
  readAssignedProductionUrl,
  hashDesiredEnv,
  listOwnDeployments,
  listProjectEnvs,
  makeDeploymentMeta,
  makeOwnershipStamp,
  observeProject,
  readOwnershipStamp,
  readProductionUrl,
  stageAliasName,
  syncProjectEnv,
  syncProjectSettings,
  type DesiredEnv,
  type ManagedEnvEntry,
  type ProjectSettingsDesired,
  type StageAliasResult,
} from "../Deploy/Engine.ts";
import type { Providers } from "../Providers.ts";
import {
  artifactFromSource,
  type FunctionSourceDescriptor,
} from "../Website/Source.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { MemoryTier } from "../Projects/Project.ts";
import {
  CRON_SECRET_ENV,
  makeVercelFunctionContext,
  type FunctionEnvironment,
  type VercelFunctionContext,
} from "./FunctionBridge.ts";
import { makeFunctionBundler } from "./FunctionBundle.ts";
import { VercelFunctionLogs } from "./Logs.ts";

export const FunctionTypeId = "Vercel.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

export const isFunction = (value: any): value is Function =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === FunctionTypeId;

export interface FunctionBuildOptions
  extends Partial<rolldown.InputOptions>, Bundle.BundleExtraOptions {
  readonly output?: Partial<rolldown.OutputOptions>;
}

export type FunctionRuntime = "nodejs22.x" | "nodejs24.x" | "bun1.x";

export interface FunctionProps extends PlatformProps {
  /**
   * Entry module bundled with rolldown. The module exports web-standard
   * handlers that Vercel's Node launcher accepts natively — a default
   * `{ fetch }` export, method exports (`export function GET`), or
   * `(req, res)` style. Exactly one of `main`, `script`, `prebuilt`, or
   * `source` is required.
   */
  main?: string;
  /** Inline module source shipped verbatim as `index.mjs` (no bundling). */
  script?: string;
  /**
   * Path to a prebuilt `.vercel/output` (Build Output v3) directory,
   * deployed as-is. Escape hatch for framework adapters.
   */
  prebuilt?: string;
  /**
   * A built website source descriptor — how `Vercel.Website.*` transformers
   * feed the deploy engine (`kind: "static"` wraps a directory in a
   * static-only artifact; `kind: "buildOutput"` passes a complete
   * `.vercel/output` tree through). Mutually exclusive with `main`,
   * `script`, and `prebuilt`.
   */
  source?: FunctionSourceDescriptor;
  /**
   * Explicit Vercel project name. If omitted, a unique name is generated
   * from `${stack}-${id}-${stage}`. Changing an explicit name replaces the
   * function's project.
   */
  name?: string;
  /**
   * Tenant mode: deploy into an existing project (a `Vercel.Project`'s
   * `projectId`, or a foreign project id/name) instead of auto-provisioning
   * one. In tenant mode the Function owns only its deployments, its stable
   * per-stage alias, and the env it delivers — never the project's
   * settings or lifecycle — and deploys `target: "preview"` by default.
   *
   * Preview tenants (the default) are **additive**: any number of stages
   * (PR stacks, per-dev scratch) can share one project without clobbering
   * each other. Each stage serves from a stable
   * `{projectName}-{stage}.vercel.app` alias (SSO-gated on team accounts —
   * drive it with the `protectionBypass` secret), and its env is delivered
   * per-deployment via the generated `.vc-config.json` — a tenant env key
   * that already exists in project env is a typed
   * `Vercel.TenantEnvConflict` error, because project env would silently
   * shadow it (live-verified precedence). Destroying the stage removes
   * only its alias and its meta-stamped deployments, leaving the shared
   * project and every other stage untouched.
   */
  project?: string;
  /**
   * Environment variables synced into project env. Values may be strings,
   * JSON-serializable values, `Redacted` secrets (become `sensitive` env
   * vars with fingerprint-comment drift detection), or `Output`s of other
   * resources' attributes.
   */
  env?: Record<string, any>;
  /**
   * Node runtime for the function.
   * @default "nodejs22.x"
   */
  runtime?: FunctionRuntime;
  /** Fluid compute resources. */
  resources?: {
    /**
     * Memory tier (project-level default on owned projects).
     * @default "standard"
     */
    memory?: MemoryTier;
    /** Max duration in seconds. */
    maxDuration?: number;
  };
  /** Regions to deploy the function to (e.g. `["iad1"]`). */
  regions?: string[];
  /**
   * Deployment target.
   * @default "production" (owned mode) / "preview" (tenant mode)
   */
  target?: "production" | "preview";
  /** Bundler configuration for {@link main}. */
  build?: FunctionBuildOptions;
  /**
   * Local dev-server options (`alchemy dev`). Ignored by live deploys.
   */
  dev?: {
    /**
     * Preferred port for the function's stable local URL. Falls back to an
     * ephemeral port when unavailable (a warning is logged).
     * @default an ephemeral port, stable for the dev session
     */
    port?: number;
  };
}

export interface Function extends Resource<
  FunctionTypeId,
  FunctionProps,
  {
    projectId: string;
    projectName: string;
    deploymentId: string;
    /**
     * The function's URL — always read back from Vercel (assigned
     * production domain, or the deployment-specific URL for previews);
     * never computed.
     */
    url: string | undefined;
    /**
     * The stable per-stage alias a preview tenant claims on the shared
     * project — `{projectName}-{stage}.vercel.app` (or the deterministic
     * suffix fallback when that hostname is taken). `undefined` outside
     * tenant-preview mode. Assigned via `assignAlias` (an upsert) after
     * every deploy, so any number of PR stages coexist in one project,
     * each behind its own stable hostname (DESIGN §5.1).
     */
    stageAlias: { uid: string; alias: string } | undefined;
    hash: {
      /** Full artifact tree hash (THE deploy skip key). */
      artifact: string;
      /** Bundle-only identity hash (diff-time change detection). */
      code: string;
      /** Desired-env hash (env changes force a redeploy). */
      env: string;
    };
    /**
     * Env rows alchemy manages on the project — removal baseline, plus the
     * persisted fingerprint/id for `sensitive` rows (which Vercel never
     * returns from the env listing).
     */
    managedEnv: ManagedEnvEntry[];
    /**
     * The project's automation protection-bypass secret (DESIGN §6.7).
     * Minted during project ensure BEFORE the first deploy (bypass secrets
     * only open deployments created after them — live-verified) and never
     * regenerated; send it as `x-vercel-protection-bypass` (header or query
     * param) to reach SSO-protected deployment URLs. `undefined` only in
     * tenant mode when the foreign project has no existing secret.
     */
    protectionBypass: Redacted.Redacted<string> | undefined;
    /**
     * The auto-minted secret guarding cron routes: synced into project env
     * as the sensitive `CRON_SECRET` var (Vercel's cron invoker sends
     * `Authorization: Bearer $CRON_SECRET` whenever it exists) and verified
     * by the bridge with a constant-time comparison. Stable across
     * reconciles; present only while crons are registered.
     */
    cronSecret: Redacted.Redacted<string> | undefined;
  },
  {
    env?: Record<string, any>;
    crons?: CronEntry[];
    routes?: BuildOutputRoute[];
    queues?: QueueTriggerEntry[];
  },
  Providers
> {}

export type FunctionServices =
  | Credentials
  | VercelEnvironment
  | FunctionEnvironment
  // The ambient host resource — capability impl layers (e.g.
  // `ReadEdgeConfigHttp`) resolve it to key per-Function child resources
  // (mirrors `SelfService` in Cloudflare's WorkerServices).
  | SelfService;

export type FunctionShape = Main<FunctionServices>;

/**
 * Map a Function's `env` prop to its runtime manifestation — every value
 * arrives in `process.env` as a string on Vercel:
 *
 * ```ts
 * export type ApiEnv = Vercel.InferEnv<typeof Api>;
 * const env = process.env as ApiEnv;
 * ```
 */
export type InferEnv<F> =
  F extends Effect.Effect<infer A, infer _E, infer _R>
    ? InferEnv<A>
    : F extends { Props: infer P }
      ? P extends { env?: infer E }
        ? { [K in keyof Exclude<E, undefined> & string]: string }
        : {}
      : never;

/** The project referenced by a tenant-mode `project:` prop does not exist. */
export class TenantProjectNotFound extends Data.TaggedError(
  "Vercel.TenantProjectNotFound",
)<{
  readonly message: string;
  readonly project: string;
}> {}

/**
 * A tenant Function's env key already exists in the shared project's env
 * (DESIGN §5.1). Tenant env is delivered per-deployment via
 * `.vc-config.json` `environment`, and project env WINS on key conflict
 * (live-verified, PROBES.md probe 3) — the tenant's value would be
 * silently shadowed, so the conflict is a hard typed error, not advisory.
 */
export class TenantEnvConflict extends Data.TaggedError(
  "Vercel.TenantEnvConflict",
)<{
  readonly message: string;
  readonly projectId: string;
  /** The env keys present both on the tenant and in project env. */
  readonly keys: ReadonlyArray<string>;
}> {}

/**
 * Tenant-mode destroy refuses to delete a foreign project's active
 * production deployment (DESIGN §5.3).
 */
export class TenantProductionDeleteRefused extends Data.TaggedError(
  "Vercel.TenantProductionDeleteRefused",
)<{
  readonly message: string;
  readonly projectId: string;
  readonly deploymentId: string;
}> {}

/** The env key the resolved URL is injected under when `yield*`-ed. */
const SELF_URL_BINDING_NAME = "FUNCTION_URL";

const SELF_URL_KIND = "Vercel.Functions.URL" as const;

/**
 * The serializable marker a `Function.URL` binding carries through the env
 * channel. The provider substitutes it with the project's READ-BACK
 * production URL during env sync — the computed `{name}.vercel.app` is
 * never load-bearing (DESIGN §6.5).
 */
export const SELF_URL_MARKER = { "~alchemy/Kind": SELF_URL_KIND } as const;

/**
 * Effect-native accessor for the Function's own URL. The value is injected
 * as a project env var that only exists on the deployed Function, so
 * reading it is deferred behind an Effect that requires
 * {@link RuntimeContext}. Yield it inside a handler to obtain the URL
 * string.
 */
export type URLAccessor = Effect.Effect<string, never, RuntimeContext>;

/**
 * The type of `Function.URL`.
 *
 * It is a real `Effect` — `yield* Vercel.Function.URL` inside a Function
 * init attaches the env binding and resolves the deferred
 * {@link URLAccessor} — but it also carries the `~alchemy/Kind` marker
 * statically, so when declared on a Function's `env` the provider
 * recognises it as a self-URL sentinel (`isSelfUrl`) instead of running it.
 */
export interface URLEffect extends Effect.Effect<URLAccessor, never, Function> {
  "~alchemy/Kind": typeof SELF_URL_KIND;
}

/**
 * Returns true when the value is a `Function.URL` sentinel — either the
 * yieldable `URLEffect` or the plain serialized marker it lowers to on the
 * binding channel. The URLEffect is a real Effect, so every env-resolution
 * site must check this before `Effect.isEffect`.
 */
export const isSelfUrl = (
  value: unknown,
): value is URLEffect | typeof SELF_URL_MARKER =>
  typeof value === "object" &&
  value !== null &&
  "~alchemy/Kind" in value &&
  (value as { "~alchemy/Kind": unknown })["~alchemy/Kind"] === SELF_URL_KIND;

/**
 * Lower the async `env:` prop onto the binding channel contract. In v1
 * (async mode, no capabilities) plain values and attribute Outputs stay in
 * props — the engine resolves them before `reconcile` — so this hook only
 * validates: whole-resource Outputs and Effect-valued entries (capability
 * bindings, which don't exist for Vercel yet) fail loudly instead of
 * silently uploading garbage.
 */
export const bindFunctionAsyncEnv = Effect.fn(function* (
  resource: Function,
  props: InputProps<FunctionProps>,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  // The env prop may itself be an unresolved Input (Config/Effect/Output
  // wrapper) — validation only applies to the plain-record shape; the
  // engine resolves the rest before reconcile.
  if (
    !props.env ||
    typeof props.env !== "object" ||
    Output.isOutput(props.env) ||
    isYieldableEffectLike(props.env)
  ) {
    return;
  }
  const env = props.env as Record<string, unknown>;
  for (const bindingName in env) {
    const value = env[bindingName];
    // `Function.URL` is Effect-shaped but is a sentinel, not a runnable env
    // value — the provider substitutes the read-back production URL during
    // env sync. Check it before the Output/Effect guards below. It is also
    // mirrored onto the binding channel as its PLAIN marker: the local
    // (dev) provider's config pipeline strips Effect-valued prop leaves,
    // so the binding-channel copy is what carries the self-URL request
    // into `alchemy dev`. The live provider reads the sentinel from the
    // merged env either way, so the duplicate key is harmless.
    if (isSelfUrl(value)) {
      yield* resource.bind(bindingName, {
        env: { [bindingName]: SELF_URL_MARKER },
      });
      continue;
    }
    if (Output.isResourceExpr(value) || Output.isRefExpr(value)) {
      return yield* Effect.die(
        `Cannot bind whole-resource Output "${bindingName}": bind one of the resource's attribute Outputs instead`,
      );
    }
    if (isYieldableEffectLike(value) && !Output.isOutput(value)) {
      return yield* Effect.die(
        `Vercel.Function env "${bindingName}": capability bindings are not supported yet — pass a plain value, Redacted secret, or attribute Output`,
      );
    }
  }
});

/**
 * A Vercel Function — a Fluid compute function deployed as an immutable
 * prebuilt Deployment of its own auto-provisioned Vercel Project.
 *
 * Two modes share one resource:
 *
 * - **Effect mode** (class/inline impl): the same two-phase pattern as
 *   `Cloudflare.Worker` — the init Effect registers bindings and returns
 *   `{ fetch }` handlers; the generated bundle wraps `main` with the Vercel
 *   runtime bridge (layer stack built once per instance, fresh Scope per
 *   request, request finalizers settle post-response via `waitUntil`).
 * - **Async mode** (no impl): `main` exports web-standard handlers
 *   directly; no Effect runtime ships in the bundle. Bindings flow through
 *   project env vars (`InferEnv` types the runtime cast).
 *
 * @resource
 * @section Effect Functions
 * @example Effect-native Function (two-phase)
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init phase — runs at plan time AND once per instance at runtime
 *     const selfUrl = yield* Vercel.Function.URL;
 *
 *     return {
 *       // runtime phase — fresh Scope per request
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         return yield* HttpServerResponse.json({
 *           url: yield* selfUrl,
 *           path: request.url,
 *         });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @example Cron schedules (Effect mode)
 * ```typescript
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Vercel.cron("0 3 * * *", Effect.log("nightly cleanup"));
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Vercel.CronEventSourceLive)),
 * ) {}
 * ```
 *
 * @section Async Functions
 * @example Defining an async Function in your stack
 * ```typescript
 * const api = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 * });
 * ```
 *
 * @example Writing the async handler
 * ```typescript
 * // src/api.ts — web-standard fetch export, no bridge, no Effect runtime
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     return Response.json({ ok: true });
 *   },
 * };
 * ```
 *
 * @example Typed environment variables
 * ```typescript
 * // stack.ts
 * export const Hooks = Vercel.Function("Hooks", {
 *   main: "./src/hooks.ts",
 *   env: {
 *     API_URL: api.url,
 *     SIGNING_KEY: Config.redacted("SIGNING_KEY"),
 *   },
 * });
 * export type HooksEnv = Vercel.InferEnv<typeof Hooks>;
 *
 * // src/hooks.ts
 * import type { HooksEnv } from "../stack.ts";
 * const env = process.env as HooksEnv;
 * ```
 *
 * @section Configuration
 * @example Fluid resources and regions
 * ```typescript
 * const api = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   resources: { memory: "performance", maxDuration: 60 },
 *   regions: ["iad1"],
 * });
 * ```
 *
 * @example Prebuilt Build Output passthrough
 * ```typescript
 * const site = yield* Vercel.Function("Site", {
 *   prebuilt: "./web/.vercel/output",
 * });
 * ```
 *
 * @section Tenancy
 * @example Deploying into a managed project
 * ```typescript
 * const legacy = yield* Vercel.Project("Legacy", { nodeVersion: "22.x" });
 * const fn = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   project: legacy.projectId,
 * });
 * ```
 *
 * @example Ephemeral PR stages sharing a durable stage's project
 * ```typescript
 * // staging stage: owns the shared project, exports it
 * const shared = yield* Vercel.Project("Shared");
 * return { projectId: shared.projectId.as<string>() };
 *
 * // PR stage: a preview tenant of staging's project (cross-stage ref).
 * // Deploys are additive (staging's production is untouched); the stage
 * // serves from a stable {project}-{stage}.vercel.app alias, its env is
 * // delivered per-deployment, and stack.destroy() removes only this
 * // stage's alias + deployments.
 * const fn = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   project: App.stage.staging.projectId,
 *   env: { FEATURE_FLAG: "pr-preview" },
 * });
 * ```
 *
 * @section Local development
 * During `alchemy dev` the Function runs locally instead of deploying: the
 * same bundle (Effect bridge included) serves from a stable
 * `http://localhost:<port>` URL with hot rebuilds, the Vercel platform env
 * (`VERCEL=1`, `VERCEL_ENV=development`, `VERCEL_URL`,
 * `VERCEL_DEPLOYMENT_ID=dev:…`) injected, and crons fired on schedule with
 * the platform invoker's exact request shape.
 *
 * @example Pin the local port
 * ```typescript
 * const api = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   dev: { port: 3000 },
 * });
 * ```
 *
 * @example Opt out of local emulation
 * ```typescript
 * // Deploys to real Vercel even during `alchemy dev`
 * const api = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 * }).pipe(Alchemy.remote());
 * ```
 *
 * @see https://vercel.com/docs/functions
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  VercelFunctionContext
> & {
  /**
   * The Function's own public URL, injected as a project env var on that
   * same Function. Declare it on `env`
   * (`env: { SELF_URL: Vercel.Function.URL }`) or `yield*` it inside an
   * Effect-native Function to obtain a deferred accessor. The value is
   * always the project's READ-BACK production alias — never computed.
   * See {@link URLEffect}.
   */
  readonly URL: URLEffect;
} = Platform(
  FunctionTypeId,
  {
    // Wrapped in arrows so imported references resolve at call time rather
    // than module-load time (mirrors Worker.ts's TDZ note).
    createRuntimeContext: (id: string) => makeVercelFunctionContext(id),
    onCreate: (resource, props) =>
      bindFunctionAsyncEnv(resource as Function, props),
  },
  {
    URL: Object.assign(
      Effect.gen(function* () {
        // Deploy-time only: register the env binding on the host Function.
        // The provider substitutes the marker with the resolved production
        // URL during env sync, just before deploy.
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* (yield* Function).bind(SELF_URL_BINDING_NAME, {
            env: { [SELF_URL_BINDING_NAME]: SELF_URL_MARKER },
          });
        }
        // The deferred read only runs at the exec phase (the accessor is
        // colored with RuntimeContext), where the env var is populated.
        return Effect.sync(
          () => process.env[SELF_URL_BINDING_NAME]!,
        ) as URLAccessor;
      }),
      {
        "~alchemy/Kind": SELF_URL_KIND,
        // Persisted props (async `env:` channel) serialize the sentinel as
        // its stable marker instead of Effect internals.
        toJSON: () => SELF_URL_MARKER,
      },
    ) as URLEffect,
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

const createProjectName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, maxLength: 100, lowercase: true }))
    );
  });

const desiredSettings = (props: FunctionProps): ProjectSettingsDesired => ({
  ...(props.resources !== undefined || props.regions !== undefined
    ? {
        resourceConfig: {
          fluid: true,
          ...(props.resources?.memory !== undefined
            ? { functionDefaultMemoryType: props.resources.memory }
            : {}),
          ...(props.regions !== undefined
            ? { functionDefaultRegions: props.regions }
            : {}),
        },
      }
    : {}),
});

/** Coerce a resolved env value to its project-env string manifestation. */
const coerceEnvValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Mint a fresh cron secret (48 hex chars). */
const mintCronSecret = Effect.sync(() =>
  Redacted.make(crypto.randomBytes(24).toString("hex")),
);

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const { bundleFunctionCode } = yield* makeFunctionBundler;
      const functionLogs = yield* VercelFunctionLogs;

      /** Merge the binding channel into env/crons/routes/queues. */
      const collectBindings = (
        bindings: ResourceBinding<Function["Binding"]>[],
      ) => {
        const active = bindings.filter(
          (b: ResourceBinding<Function["Binding"]> & { action?: string }) =>
            b.action !== "delete",
        );
        const env = active
          .map((b) => b?.data?.env)
          .reduce<Record<string, any>>((acc, e) => ({ ...acc, ...e }), {});
        const crons = active.flatMap((b) => b?.data?.crons ?? []);
        const routes = active.flatMap((b) => b?.data?.routes ?? []);
        const queues = active.flatMap((b) => b?.data?.queues ?? []);
        return { env, crons, routes, queues };
      };

      /**
       * Desired project-env rows: props env ⊎ binding env ⊎ managed vars
       * (`CRON_SECRET`, alchemy stamp). `Function.URL` sentinels are
       * substituted with the READ-BACK production URL here, so a changed
       * URL flows into the env hash and forces a redeploy.
       */
      const desiredEnvRows = (input: {
        id: string;
        news: FunctionProps;
        bindingEnv: Record<string, any>;
        tenant: boolean;
        selfUrl: string | undefined;
        cronSecret: Redacted.Redacted<string> | undefined;
      }) =>
        Effect.gen(function* () {
          const rows: DesiredEnv[] = [];
          const merged = { ...input.bindingEnv, ...input.news.env };
          for (const key of Object.keys(merged)) {
            let value = merged[key];
            if (value === undefined) continue;
            if (isSelfUrl(value)) {
              if (input.selfUrl === undefined) {
                return yield* Effect.die(
                  `Vercel.Function(${input.id}): cannot resolve Function.URL for env "${key}" — the project has no assigned production domain to read back`,
                );
              }
              value = input.selfUrl;
            }
            rows.push({
              key,
              // Redacted secrets stay wrapped — syncProjectEnv turns them
              // into `sensitive` env vars with fingerprint comments.
              value: Redacted.isRedacted(value)
                ? (value as Redacted.Redacted<string>)
                : coerceEnvValue(value),
            });
          }
          if (input.cronSecret !== undefined) {
            // Sensitive (Redacted ⇒ sensitive): Vercel's cron invoker sends
            // `Authorization: Bearer $CRON_SECRET` when this var exists; the
            // bridge verifies it constant-time on every cron route.
            rows.push({ key: CRON_SECRET_ENV, value: input.cronSecret });
          }
          if (!input.tenant) {
            const stamp = yield* makeOwnershipStamp(input.id);
            rows.push({
              key: ALCHEMY_META_KEY,
              value: JSON.stringify(stamp),
              type: "plain",
            });
          }
          return rows;
        });

      /** Build the artifact for the resolved props + contributed bindings. */
      const buildArtifact = (input: {
        id: string;
        news: FunctionProps;
        crons: CronEntry[];
        routes: BuildOutputRoute[];
        queues: QueueTriggerEntry[];
        /**
         * Per-deployment env baked into `.vc-config.json` `environment`
         * (tenant mode, DESIGN §5.1). Part of the artifact — and therefore
         * the artifact hash — so tenant env changes force a redeploy.
         */
        environment?: Record<string, string>;
      }) =>
        Effect.gen(function* () {
          if (
            input.news.source !== undefined ||
            input.news.prebuilt !== undefined
          ) {
            if (input.queues.length > 0) {
              return yield* Effect.die(
                `Vercel.Function(${input.id}): queue subscriptions require an Effect-mode \`main\` Function — a source/prebuilt output tree cannot carry the generated consumer function`,
              );
            }
            if (
              input.environment !== undefined &&
              Object.keys(input.environment).length > 0
            ) {
              return yield* Effect.die(
                `Vercel.Function(${input.id}): tenant-mode env delivery rewrites the generated \`.vc-config.json\` — a source/prebuilt output tree cannot carry per-deployment env. Move the env onto the shared project (Vercel.ProjectEnv) or use a \`main\` Function`,
              );
            }
          }
          if (input.news.source !== undefined) {
            // Website source (Website.* transformers): the artifact IS the
            // built tree — no bundling, no synthesized config.
            const artifact = yield* artifactFromSource(input.news.source);
            return { artifact, codeHash: artifact.hash };
          }
          if (input.news.prebuilt !== undefined) {
            const artifact = yield* fromBuildOutputDir(input.news.prebuilt);
            return { artifact, codeHash: artifact.hash };
          }
          const bundle = yield* bundleFunctionCode(input.id, input.news);
          const vcConfig: VcConfig = {
            runtime: input.news.runtime ?? "nodejs22.x",
            handler: "index.mjs",
            launcherType: "Nodejs",
            supportsResponseStreaming: true,
            ...(input.environment !== undefined &&
            Object.keys(input.environment).length > 0
              ? { environment: input.environment }
              : {}),
            ...(input.news.resources?.maxDuration !== undefined
              ? { maxDuration: input.news.resources.maxDuration }
              : {}),
            ...(input.news.regions !== undefined
              ? { regions: input.news.regions }
              : {}),
          };
          // Queue subscriptions lower into a SEPARATE consumer function
          // (D9a): the trigger lives in ITS `.vc-config.json` so the public
          // function keeps its HTTP routing (a trigger on the main function
          // kills ALL public routes — live-verified). The consumer bundle
          // shares the user's module; its bridge dispatches deliveries to
          // the init-registered `subscribe` handlers.
          let queueConsumer:
            | {
                bundle: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
                vcConfig: VcConfig;
              }
            | undefined;
          if (input.queues.length > 0) {
            const consumerBundle = yield* bundleFunctionCode(
              input.id,
              input.news,
              "queue",
            );
            queueConsumer = {
              bundle: consumerBundle.files,
              vcConfig: {
                ...vcConfig,
                experimentalTriggers: input.queues.map((queue) => ({
                  type: "queue/v2beta" as const,
                  ...queue,
                })),
              },
            };
          }
          const artifact = yield* fromFunctionBundle({
            bundle: bundle.files,
            vcConfig,
            crons: input.crons,
            routes: input.routes,
            ...(queueConsumer !== undefined ? { queueConsumer } : {}),
          });
          return { artifact, codeHash: bundle.identityHash };
        });

      /** Resolve the target project (owned: ensure; tenant: observe). */
      const resolveProject = (input: {
        id: string;
        news: FunctionProps;
        output: Function["Attributes"] | undefined;
      }) =>
        Effect.gen(function* () {
          if (input.news.project !== undefined) {
            const project = yield* observeProject(input.news.project);
            if (project === undefined) {
              return yield* new TenantProjectNotFound({
                message: `Vercel.Function(${input.id}): tenant project '${input.news.project}' does not exist`,
                project: input.news.project,
              });
            }
            return { project, tenant: true as const };
          }
          // `|| undefined` guards the inert precreate stub (empty strings),
          // which must never become a project name.
          const name =
            (input.output?.projectName || undefined) ??
            (yield* createProjectName(input.id, input.news.name));
          const project = yield* ensureProject({
            name,
            desired: desiredSettings(input.news),
          });
          return { project, tenant: false as const };
        });

      const functionUrl = (input: {
        projectId: string;
        target: "production" | "preview";
        deploymentUrl: string | undefined;
      }) =>
        Effect.gen(function* () {
          if (input.target === "production") {
            const fresh = yield* observeProject(input.projectId);
            const url =
              fresh !== undefined ? readProductionUrl(fresh) : undefined;
            if (url !== undefined) return url;
          }
          return input.deploymentUrl !== undefined
            ? `https://${input.deploymentUrl}`
            : undefined;
        });

      return {
        stables: ["projectId", "projectName"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // Reparenting between projects (or between owned and tenant mode)
          // replaces the function.
          if ((olds?.project ?? undefined) !== (news.project ?? undefined)) {
            return { action: "replace" } as const;
          }
          // Engine-owned physical names: only an explicit name change can
          // force a replace.
          if (news.project === undefined) {
            const newName = news.name ?? output.projectName;
            if (newName !== output.projectName) {
              return { action: "replace" } as const;
            }
          }
          // Code identity — catches `main` content changes that props alone
          // can't see. Prebuilt/source trees hash the whole directory.
          if (news.source !== undefined) {
            const artifact = yield* artifactFromSource(news.source);
            if (artifact.hash !== output.hash.code) {
              return { action: "update" } as const;
            }
          } else if (news.prebuilt !== undefined) {
            const artifact = yield* fromBuildOutputDir(news.prebuilt);
            if (artifact.hash !== output.hash.code) {
              return { action: "update" } as const;
            }
          } else {
            const bundle = yield* bundleFunctionCode(id, news);
            if (bundle.identityHash !== output.hash.code) {
              return { action: "update" } as const;
            }
          }
          // Everything else falls through to the engine's default
          // props/bindings comparison.
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // `|| undefined` guards the inert precreate stub (empty strings).
          const idOrName =
            (output?.projectId || undefined) ??
            olds?.project ??
            (yield* createProjectName(id, olds?.name));
          const project = yield* observeProject(idOrName);
          if (project === undefined) return undefined;
          const observedBypass = findAutomationBypassSecret(project);
          const attrs: Function["Attributes"] = {
            projectId: project.id,
            projectName: project.name,
            deploymentId: output?.deploymentId ?? "",
            url:
              output?.stageAlias !== undefined
                ? `https://${output.stageAlias.alias}`
                : (readProductionUrl(project) ?? output?.url),
            stageAlias: output?.stageAlias,
            hash: output?.hash ?? { artifact: "", code: "", env: "" },
            managedEnv: output?.managedEnv ?? [],
            protectionBypass:
              observedBypass !== undefined
                ? Redacted.make(observedBypass)
                : output?.protectionBypass,
            cronSecret: output?.cronSecret,
          };
          if (olds?.project !== undefined) {
            // Tenant mode: the project is foreign by definition; ownership
            // is per-deployment via meta stamps, so the row is ours.
            return attrs;
          }
          const stamp = yield* readOwnershipStamp(project.id);
          const expected = yield* makeOwnershipStamp(id);
          return stamp !== undefined &&
            stamp.stack === expected.stack &&
            stamp.stage === expected.stage &&
            stamp.logicalId === expected.logicalId
            ? attrs
            : Unowned(attrs);
        }),
        precreate: Effect.fn(function* ({ id, news }) {
          // Precreate runs BEFORE upstream resolution (it exists to break
          // binding cycles), so props may still carry unresolved Inputs.
          // The `env` and `exports` channels are EXPECTED to be unresolved
          // here — cycle partners' init captures (e.g. a blob store's
          // `storeId` accessor riding the env channel) resolve only after
          // the partner reconciles against the pre-created stub, and
          // precreate never reads either channel. Gate the inert stub only
          // on the project-facing props precreate actually consumes
          // (tenant `project:` ref, `name`, settings): if e.g. a tenant
          // `project:` still references an unreconciled Project there is
          // nothing to pre-create against — return the stub and let
          // reconcile observe the real project once the reference
          // resolves.
          const {
            env: _cycleEnv,
            exports: _cycleExports,
            ...projectFacing
          } = (news ?? {}) as Record<string, unknown>;
          if (!isResolved(projectFacing)) {
            return {
              projectId: "",
              projectName: "",
              deploymentId: "",
              url: undefined,
              stageAlias: undefined,
              hash: { artifact: "", code: "", env: "" },
              managedEnv: [],
              protectionBypass: undefined,
              cronSecret: undefined,
            } satisfies Function["Attributes"];
          }
          // Ensure the project exists and READ BACK the assigned domain —
          // the computed `https://{name}.vercel.app` is never load-bearing
          // (DESIGN §6.5).
          const { project, tenant } = yield* resolveProject({
            id,
            news: projectFacing as FunctionProps,
            output: undefined,
          });
          // Mint the automation bypass secret at project ensure, BEFORE any
          // deploy exists — bypass secrets only open deployments created
          // AFTER them (§6.7, live-verified). Minted in tenant mode too
          // (additive; the tenant's SSO-gated stage alias needs it), while
          // an existing secret is always kept, never regenerated.
          const protectionBypass = yield* ensureProtectionBypass(project);
          let managedEnv: ManagedEnvEntry[] = [];
          if (!tenant) {
            const stamp = yield* makeOwnershipStamp(id);
            const envSync = yield* syncProjectEnv({
              idOrName: project.id,
              desired: [
                {
                  key: ALCHEMY_META_KEY,
                  value: JSON.stringify(stamp),
                  type: "plain",
                },
              ],
              managedEnv: [{ key: ALCHEMY_META_KEY, type: "plain" }],
            });
            managedEnv = [...envSync.managedEnv];
          }
          return {
            projectId: project.id,
            projectName: project.name,
            deploymentId: "",
            // Greenfield projects carry no alias rows before the first
            // deployment, but the assigned `{name}.vercel.app` project
            // domain exists from creation — read it back so circular
            // capabilities (InvokeFunction A↔B) can bind a real URL off
            // the pre-created stub. Still read-back, never computed.
            url:
              readProductionUrl(project) ??
              (yield* readAssignedProductionUrl(project.id)),
            stageAlias: undefined,
            hash: { artifact: "", code: "", env: "" },
            managedEnv,
            protectionBypass,
            cronSecret: undefined,
          } satisfies Function["Attributes"];
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          // 1. Observe + ensure the project.
          const { project, tenant } = yield* resolveProject({
            id,
            news,
            output,
          });
          const target = news.target ?? (tenant ? "preview" : "production");

          // 1b. Protection bypass (§6.7): observe-and-keep — mint only when
          //     absent, always BEFORE deploying (a bypass secret only opens
          //     deployments created after it). Minted in TENANT mode too:
          //     the tenant's stage alias and deployment URLs are SSO-gated
          //     on team accounts, and the automation bypass secret is the
          //     only way to drive them. Minting is additive — it never
          //     changes the foreign project's protection level, and an
          //     existing secret is always kept, never regenerated.
          const protectionBypass = yield* ensureProtectionBypass(project);

          // 2. Sync settings (owned mode only — a tenant never touches a
          //    foreign project's settings).
          if (!tenant) {
            yield* syncProjectSettings({
              project,
              desired: desiredSettings(news),
            });
          }

          // 3. Desired env. Owned mode syncs PROJECT env against the
          //    observed rows (adoption-safe); tenant mode delivers env
          //    PER-DEPLOYMENT via `.vc-config.json` `environment`
          //    (DESIGN §5.1) and never touches the shared project's env.
          const contributed = collectBindings(bindings);
          // Cron secret: stable across reconciles (a rotating value would
          // force a redeploy every deploy); dropped with the last cron.
          const cronSecret =
            contributed.crons.length > 0
              ? (output?.cronSecret ?? (yield* mintCronSecret))
              : undefined;
          const stamp = yield* makeOwnershipStamp(id);
          // Self-URL for `Function.URL` bindings, resolved BEFORE the
          // deploy (env only takes effect on new deployments). Owned mode:
          // the project body's alias when it exists, else the assigned
          // project domain (greenfield — no deployment yet, but the
          // production domain is assigned at project creation), always read
          // back. Tenant preview: the stable per-stage alias this reconcile
          // is about to claim — the persisted alias when present (it
          // survives a suffix fallback), else the deterministic base name.
          const needsSelfUrl = Object.values({
            ...contributed.env,
            ...news.env,
          }).some(isSelfUrl);
          const selfUrl = !needsSelfUrl
            ? undefined
            : tenant && target === "preview"
              ? `https://${output?.stageAlias?.alias ?? stageAliasName(project.name, stamp.stage)}`
              : (readProductionUrl(project) ??
                (yield* readAssignedProductionUrl(project.id)) ??
                output?.url);
          const envRows = yield* desiredEnvRows({
            id,
            news,
            bindingEnv: contributed.env,
            tenant,
            selfUrl,
            cronSecret,
          });
          const envHash = yield* hashDesiredEnv(envRows);

          // 3b. Tenant mode: the MANDATORY cross-tenant conflict check —
          //     project env WINS over `.vc-config.json` env on key conflict
          //     (live-verified, PROBES.md probe 3), so a conflicting tenant
          //     key would be silently shadowed. Hard typed error, then
          //     resolve the per-deployment environment map. Owned mode:
          //     sync project env by observed-vs-desired delta.
          let tenantEnvironment: Record<string, string> | undefined;
          let envChanged = false;
          let managedEnv: ManagedEnvEntry[] = [...(output?.managedEnv ?? [])];
          if (tenant) {
            const observedProjectEnv = yield* listProjectEnvs(project.id);
            const projectKeys = new Set(
              observedProjectEnv.map((row) => row.key),
            );
            const conflicts = envRows
              .map((row) => row.key)
              .filter((key) => projectKeys.has(key));
            if (conflicts.length > 0) {
              return yield* new TenantEnvConflict({
                message:
                  `Vercel.Function(${id}): tenant env key(s) [${conflicts.join(", ")}] already exist in shared project ${project.id}'s env — ` +
                  "project env wins over per-deployment env on conflict, so the tenant's value would be silently shadowed. " +
                  "Rename the key(s) or manage them on the shared project instead.",
                projectId: project.id,
                keys: conflicts,
              });
            }
            tenantEnvironment = Object.fromEntries(
              envRows.map((row) => [
                row.key,
                Redacted.isRedacted(row.value)
                  ? Redacted.value(row.value)
                  : row.value,
              ]),
            );
          } else {
            const envSync = yield* syncProjectEnv({
              idOrName: project.id,
              desired: envRows,
              managedEnv: output?.managedEnv ?? [],
            });
            envChanged = envSync.changed;
            managedEnv = [...envSync.managedEnv];
          }

          // 4. Build the artifact. Tenant env rides inside the generated
          //    `.vc-config.json`, so it participates in the artifact hash
          //    (tenant env changes force a redeploy through the artifact,
          //    not through `envChanged`).
          const { artifact, codeHash } = yield* buildArtifact({
            id,
            news,
            crons: contributed.crons,
            routes: contributed.routes,
            queues: contributed.queues,
            ...(tenantEnvironment !== undefined
              ? { environment: tenantEnvironment }
              : {}),
          });
          // Target participates in the content identity: retargeting
          // production ↔ preview must produce a new deployment even when
          // code and env are unchanged.
          const contentHash = yield* sha256(
            `${artifact.hash}:${envHash}:${target}`,
          );
          const meta = makeDeploymentMeta(stamp, contentHash);

          // Tenant-preview: converge the stable per-stage alias onto the
          // final deployment — on EVERY path (skip, crash recovery, fresh
          // deploy), so an out-of-band alias deletion or re-point heals.
          const settleStageAlias = (deploymentId: string) =>
            tenant && target === "preview"
              ? Effect.map(
                  ensureStageAlias({
                    projectName: project.name,
                    stage: stamp.stage,
                    stack: stamp.stack,
                    deploymentId,
                    previous: output?.stageAlias,
                  }),
                  (alias): StageAliasResult | undefined => alias,
                )
              : Effect.succeed<StageAliasResult | undefined>(undefined);

          // 5. Skip-on-hash: same artifact + same env + a live deployment
          //    means nothing to deploy (env changes force a redeploy —
          //    Vercel env only takes effect on new deployments).
          const previousTarget =
            olds?.target ??
            (olds?.project !== undefined ? "preview" : "production");
          if (
            output !== undefined &&
            output.deploymentId !== "" &&
            output.hash.artifact === artifact.hash &&
            output.hash.env === envHash &&
            !envChanged &&
            olds !== undefined &&
            previousTarget === target
          ) {
            const stageAlias = yield* settleStageAlias(output.deploymentId);
            return {
              ...output,
              projectId: project.id,
              projectName: project.name,
              ...(stageAlias !== undefined
                ? { stageAlias, url: `https://${stageAlias.alias}` }
                : {}),
              hash: { artifact: artifact.hash, code: codeHash, env: envHash },
              managedEnv,
              protectionBypass,
              cronSecret,
            } satisfies Function["Attributes"];
          }

          // 6. Crash recovery: an unrecorded-but-matching deployment (state
          //    persistence died after createDeployment) is reused, not
          //    duplicated.
          const recovered = yield* findDeploymentByContentHash({
            projectId: project.id,
            contentHash,
          });
          if (recovered !== undefined) {
            const stageAlias = yield* settleStageAlias(recovered.uid);
            return {
              projectId: project.id,
              projectName: project.name,
              deploymentId: recovered.uid,
              url:
                stageAlias !== undefined
                  ? `https://${stageAlias.alias}`
                  : yield* functionUrl({
                      projectId: project.id,
                      target,
                      deploymentUrl: recovered.url,
                    }),
              stageAlias,
              hash: { artifact: artifact.hash, code: codeHash, env: envHash },
              managedEnv,
              protectionBypass,
              cronSecret,
            } satisfies Function["Attributes"];
          }

          // 7. Deploy.
          yield* session.note(
            `Deploying ${artifact.files.length} file(s) to Vercel project ${project.name}`,
          );
          const result = yield* deployArtifact({
            projectName: project.name,
            artifact,
            target,
            meta,
          });

          // 8. Converge the tenant stage alias onto the fresh deployment,
          //    then return fresh attributes — URL read back, never computed.
          const stageAlias = yield* settleStageAlias(result.deploymentId);
          return {
            projectId: project.id,
            projectName: project.name,
            deploymentId: result.deploymentId,
            url:
              stageAlias !== undefined
                ? `https://${stageAlias.alias}`
                : yield* functionUrl({
                    projectId: project.id,
                    target,
                    deploymentUrl: result.aliases[0] ?? result.deploymentUrl,
                  }),
            stageAlias,
            hash: { artifact: artifact.hash, code: codeHash, env: envHash },
            managedEnv,
            protectionBypass,
            cronSecret,
          } satisfies Function["Attributes"];
        }),
        delete: Effect.fn(function* ({ id, olds, output }) {
          // An inert precreate stub (props never resolved, reconcile never
          // ran) tracks no cloud state.
          if (output.projectId === "") return;
          if (olds?.project !== undefined) {
            // Tenant mode: remove ONLY this stage's alias and our own
            // meta-stamped deployments plus the env keys we manage — never
            // the shared project itself, and never its active production
            // deployment.
            const stamp = yield* makeOwnershipStamp(id);
            const own = yield* listOwnDeployments({
              projectId: output.projectId,
              stamp,
            });
            const activeProduction = own.find(
              (d) =>
                d.target === "production" && d.readySubstate === "PROMOTED",
            );
            if (activeProduction !== undefined) {
              return yield* new TenantProductionDeleteRefused({
                message:
                  `Vercel.Function(${id}): refusing to delete deployment ${activeProduction.uid} — it is the active production deployment of foreign project ${output.projectId}. ` +
                  "Promote another deployment (or delete it manually) first.",
                projectId: output.projectId,
                deploymentId: activeProduction.uid,
              });
            }
            // Stage alias first (after the refusal gate, so a refused
            // destroy leaves the tenant fully intact), then deployments.
            if (output.stageAlias !== undefined) {
              yield* deleteAliasByIdOrName(output.stageAlias.uid);
            }
            for (const deployment of own) {
              yield* deleteDeploymentById(deployment.uid);
            }
            if (output.managedEnv.length > 0) {
              yield* syncProjectEnv({
                idOrName: output.projectId,
                desired: [],
                managedEnv: output.managedEnv,
              }).pipe(
                // The foreign project may already be gone.
                Effect.catchTag("NotFound", () => Effect.void),
              );
            }
            return;
          }
          // Owned mode: the project cascades everything (deployments, env,
          // domains). Idempotent on the typed NotFound.
          yield* deleteProjectByIdOrName(output.projectId);
        }),
        tail: ({ output }) =>
          functionLogs.tail({
            projectId: output.projectId,
            deploymentId: output.deploymentId,
          }),
        logs: ({ output, options }) =>
          functionLogs.logs({
            target: {
              projectId: output.projectId,
              deploymentId: output.deploymentId,
            },
            options,
          }),
      };
    }),
  );
