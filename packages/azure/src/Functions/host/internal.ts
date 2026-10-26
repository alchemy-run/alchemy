/**
 * Deploy and runtime machinery shared by the hosts that run on the Azure
 * Functions Node.js worker: `Azure.Functions.Function` and
 * `Azure.Web.FunctionApp`. Not exported from the package.
 */
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as kudu from "@distilled.cloud/azure/kudu";
import * as web from "@distilled.cloud/azure/web";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isScopeEjected, safeHttpEffect, type HttpEffect } from "alchemy/Http";
import type { ResourceBinding } from "alchemy/Resource";
import { createHostRuntimeContext } from "alchemy/Runtime/Process";
import { packEnvValue, type BaseRuntimeContext } from "alchemy/RuntimeContext";
import { sha256Object } from "alchemy/Util/sha256";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../../Arm.ts";
import { BuiltInRole } from "../../Authorization/RoleAssignment.ts";
import { managedIdentityHostBundle } from "../../AzureBindings.ts";
import type {
  FunctionBinding,
  FunctionEventSubscription,
  FunctionRoleAssignment,
  FunctionRuntimeContext,
} from "../Function.ts";
import { functionRegistry } from "../internal.ts";

/** The props the Functions bundler reads. */
export interface FunctionsBundleProps {
  main: string;
  handler?: string;
  build?: Bundle.BundleConfig;
  env?: Record<string, unknown>;
  isExternal?: boolean;
  /** Extra `extensions` entries for host.json (`durableTask` for a WorkflowFunction). */
  hostExtensions?: Record<string, unknown>;
  /**
   * Bundle for the local runtime (`alchemy dev`): a Node.js HTTP server
   * instead of the Functions worker, and the ambient (emulator) credentials
   * instead of a managed identity.
   */
  local?: boolean;
}

/**
 * Run `effect` under the program's captured context. Handlers are stored
 * with erased (`any`) requirements and the context holds every service the
 * program's init had, so the cast only drops the erased `any`.
 */
const runInContext = <A, E>(effect: Effect.Effect<A, E, any>, context: Context.Context<never>) =>
  Effect.runPromise(effect.pipe(Effect.provideContext(context)) as Effect.Effect<A, E>);

/**
 * Web-standard dispatcher over the program's `fetch`: each request runs
 * under the program's context with its own scope.
 */
const makeDispatcher =
  (handler: HttpEffect<any>, context: Context.Context<never>) =>
  (webRequest: Request): Promise<Response> =>
    runInContext(
      Effect.gen(function* () {
        const request = HttpServerRequest.fromWeb(webRequest);
        const scope = yield* Scope.make();
        const out = yield* Deferred.make<Response>();
        yield* EffectHttp.toHandled(safeHttpEffect(handler), (req, response) =>
          Deferred.succeed(
            out,
            HttpServerResponse.toWeb(EffectHttp.scopeTransferToStream(response), {
              withoutBody: req.method === "HEAD",
              context,
            }),
          ),
        ).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(Scope.Scope, scope),
        );
        const response = yield* Deferred.await(out);
        if (!isScopeEjected(scope)) yield* Scope.close(scope, Exit.void);
        return response;
      }),
      context,
    );

/**
 * Runtime context of a host that runs on the Functions Node.js worker
 * (`Azure.Functions.Function`, `Azure.Web.FunctionApp`): `serve` and
 * `trigger` fill the worker registry the bootstraps read.
 */
export const makeFunctionsRuntimeContext =
  (type: string) =>
  (id: string): FunctionRuntimeContext => {
    // No `run`: instances scale to zero, so background loops would stop.
    const {
      run: _run,
      exports: _exports,
      serve: _serve,
      ...base
    } = createHostRuntimeContext(type)(id);
    const serve = ((handler: HttpEffect<any>) =>
      globalThis.__ALCHEMY_RUNTIME__
        ? Effect.gen(function* () {
            const context = yield* Effect.context<never>();
            functionRegistry().http = makeDispatcher(handler, context);
          })
        : Effect.void) as NonNullable<BaseRuntimeContext["serve"]>;
    return {
      ...base,
      serve,
      trigger: (name, binding, handler) =>
        globalThis.__ALCHEMY_RUNTIME__
          ? Effect.gen(function* () {
              const context = yield* Effect.context<never>();
              functionRegistry().triggers.set(name, {
                binding,
                run: (invocation) => runInContext(Effect.scoped(handler(invocation)), context),
              });
            })
          : Effect.void,
    };
  };

export class FunctionDeployFailed extends Data.TaggedError("Azure.Functions.FunctionDeployFailed")<{
  functionAppName: string;
  message: string;
}> {}

/** Roles the app's identity needs on its own host storage account. */
export const HOST_STORAGE_ROLES = [
  BuiltInRole.StorageBlobDataOwner,
  BuiltInRole.StorageQueueDataContributor,
  "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3", // Storage Table Data Contributor
];

const hostJsonOf = (hostExtensions?: Record<string, unknown>) =>
  `${JSON.stringify(
    {
      version: "2.0",
      extensions: {
        http: { routePrefix: "" },
        // Queue messages are plain text, as `Storage.QueueSend` writes them.
        queues: { messageEncoding: "none" },
        ...hostExtensions,
      },
      extensionBundle: {
        id: "Microsoft.Azure.Functions.ExtensionBundle",
        version: "[4.*, 5.0.0)",
      },
    },
    null,
    2,
  )}\n`;

const PACKAGE_JSON = `${JSON.stringify({ type: "module", main: "index.mjs" }, null, 2)}\n`;

/** Generated entry of an Effect Function: raise the runtime flag, run init, register. */
const effectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/Functions";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async Function: no Effect, just the handler file. */
const asyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { serve } from "@alchemy.run/azure/Bootstrap/FunctionsAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

serve(handler, ${JSON.stringify(envKeys)});
`;

/** Generated entry of an Effect Function under `alchemy dev`. */
const localEffectEntry = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/FunctionsLocal";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an async Function under `alchemy dev`. */
const localAsyncEntry = (handler: string, envKeys: readonly string[]) => (importPath: string) =>
  `
import { serve } from "@alchemy.run/azure/Bootstrap/FunctionsLocalAsync";
import { ${handler} as handler } from ${JSON.stringify(importPath)};

await serve(handler, ${JSON.stringify(envKeys)});
`;

/** Bundles `main` into the package the Functions Node.js worker loads. */
export const makeBundler = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  return Effect.fn(function* (props: FunctionsBundleProps) {
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);
    const handler = props.handler ?? "default";
    const envKeys = Object.keys(props.env ?? {}).sort();
    const entry = props.local
      ? props.isExternal
        ? localAsyncEntry(handler, envKeys)
        : localEffectEntry(handler)
      : props.isExternal
        ? asyncEntry(handler, envKeys)
        : effectEntry(handler);
    const input = {
      ...props.build?.input,
      input: realMain,
      cwd,
      platform: "node" as const,
      resolve: {
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        ...props.build?.input?.resolve,
      },
      plugins: [props.build?.input?.plugins, virtualEntryPlugin(entry)],
    };
    const output = yield* Bundle.build(
      // A local runtime has no managed identity: bindings use the
      // credentials its bootstrap provides.
      props.local ? input : managedIdentityHostBundle(input),
      {
        ...props.build?.output,
        format: "esm",
        sourcemap: props.build?.output?.sourcemap ?? false,
        entryFileNames: "index.mjs",
      },
      props.build,
    );
    // The scale controller reads host.json itself, so these cannot be app-setting overrides.
    const hostJson = hostJsonOf(props.hostExtensions);
    const files = [
      ...output.files.map((file) => ({
        path: file.path,
        content:
          typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
      })),
      { path: "host.json", content: hostJson },
      { path: "package.json", content: PACKAGE_JSON },
    ];
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      host: hostJson,
      package: PACKAGE_JSON,
      envKeys: props.isExternal ? envKeys : [],
    })).slice(0, 16);
    return { files, codeHash };
  });
});

/** `name.region.azurewebsites.net` → `name.scm.region.azurewebsites.net`. */
export const scmHostOf = (
  site: { properties?: { hostNameSslStates?: { hostType?: string; name?: string }[] } },
  defaultHostName: string,
) =>
  site.properties?.hostNameSslStates?.find((state) => state.hostType === "Repository")?.name ??
  [defaultHostName.split(".")[0], "scm", ...defaultHostName.split(".").slice(1)].join(".");

/** An env value as an app setting: strings as-is, anything else packed. */
export const envString = (value: unknown): string =>
  typeof value === "string" ? value : packEnvValue(value);

/** Merge the active bindings' env, role grants, and Event Grid subscriptions. */
export const collectBindings = (bindings: ResourceBinding<FunctionBinding>[]) => {
  const env: Record<string, unknown> = {};
  const grants = new Map<string, FunctionRoleAssignment>();
  const subscriptions = new Map<string, FunctionEventSubscription>();
  const active = bindings.filter(
    (b: ResourceBinding<FunctionBinding> & { action?: string }) => b.action !== "delete",
  );
  for (const binding of active) {
    Object.assign(env, binding.data.env ?? {});
    for (const grant of binding.data.roleAssignments ?? []) {
      grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
    }
    for (const sub of binding.data.eventSubscriptions ?? []) {
      subscriptions.set(`${sub.scope.toLowerCase()}|${sub.name}`, sub);
    }
  }
  return {
    env,
    grants: [...grants.values()],
    eventSubscriptions: [...subscriptions.values()],
  };
};

export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Kudu deployment status: 3 failed, 4 succeeded. */
const DEPLOY_FAILED = 3;
const DEPLOY_SUCCEEDED = 4;

/**
 * Zip-deploy the package with OneDeploy and wait for the deployment to
 * finish. The first deploy of a new app can fail while its identity's
 * storage roles propagate, so a failed deployment is retried (bounded).
 */
export const deployPackage = (options: {
  functionAppName: string;
  scmHostName: string;
  archive: Uint8Array;
  /** OneDeploy artifact type; dedicated and Premium plans need `zip`. */
  artifactType?: string;
}) =>
  Effect.gen(function* () {
    const { scmHostName } = options;
    const before = yield* orUndefinedIfNotFound(kudu.GetLatestDeployment({ scmHostName }));
    yield* kudu
      .DeployArtifact({
        scmHostName,
        body: options.archive,
        contentType: "application/zip",
        type: options.artifactType,
        RemoteBuild: false,
        Deployer: "alchemy",
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "KuduDeploymentInProgress",
          schedule: Schedule.spaced("10 seconds"),
          times: 12,
        }),
      );
    const latest = yield* orUndefinedIfNotFound(kudu.GetLatestDeployment({ scmHostName })).pipe(
      Effect.repeat({
        until: (d) => d !== undefined && d.id !== before?.id && d.complete === true,
        schedule: Schedule.spaced("5 seconds"),
        times: 60,
      }),
    );
    if (latest?.status !== DEPLOY_SUCCEEDED) {
      return yield* new FunctionDeployFailed({
        functionAppName: options.functionAppName,
        message:
          latest?.status === DEPLOY_FAILED
            ? `deployment ${latest.id} failed: ${latest.statusText ?? latest.message ?? ""}`
            : `deployment did not finish (last status ${latest?.status ?? "unknown"})`,
      });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Azure.Functions.FunctionDeployFailed",
      schedule: Schedule.spaced("20 seconds"),
      times: 5,
    }),
  );

export class FunctionsNotIndexed extends Data.TaggedError("Azure.Functions.FunctionsNotIndexed")<{
  functionAppName: string;
  missing: string[];
}> {
  override get message() {
    return `function app ${this.functionAppName} has not indexed: ${this.missing.join(", ")}`;
  }
}

/**
 * Wait until the host lists `names` among its functions: the worker indexes
 * them when the new package first starts (bounded, about 4 minutes).
 */
export const waitForFunctions = (
  where: { subscriptionId: string; resourceGroupName: string; name: string },
  names: string[],
) =>
  web.ListWebAppFunctions(where).pipe(
    Effect.flatMap((page) => {
      const listed = new Set(
        (page.value ?? []).map((f) => (f.name ?? "").split("/").pop()?.toLowerCase()),
      );
      const missing = names.filter((n) => !listed.has(n.toLowerCase()));
      return missing.length === 0
        ? Effect.void
        : Effect.fail(new FunctionsNotIndexed({ functionAppName: where.name, missing }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Azure.Functions.FunctionsNotIndexed",
      schedule: Schedule.spaced("10 seconds"),
      times: 24,
    }),
  );

/** Create or update the Event Grid subscriptions bindings asked for; drop stale ones. */
export const syncEventSubscriptions = Effect.fn(function* (options: {
  subscriptionId: string;
  siteId: string;
  desired: FunctionEventSubscription[];
  previous: { scope: string; name: string }[];
}) {
  if (options.desired.length > 0) {
    yield* ensureRegistered(options.subscriptionId, "Microsoft.EventGrid");
  }
  for (const sub of options.desired) {
    const where = { scope: sub.scope, eventSubscriptionName: sub.name };
    const resourceId = `${options.siteId}/functions/${sub.functionName}`;
    const observed = yield* orUndefinedIfNotFound(eventgrid.GetEventSubscription(where));
    const destination = observed?.properties?.destination as
      | { endpointType?: string; properties?: { resourceId?: string } }
      | undefined;
    const filter = observed?.properties?.filter;
    const same =
      observed?.properties?.provisioningState === "Succeeded" &&
      destination?.endpointType === "AzureFunction" &&
      sameName(destination.properties?.resourceId, resourceId) &&
      JSON.stringify(filter?.includedEventTypes ?? []) ===
        JSON.stringify(sub.includedEventTypes ?? []) &&
      (filter?.subjectBeginsWith ?? "") === (sub.subjectBeginsWith ?? "") &&
      (filter?.subjectEndsWith ?? "") === (sub.subjectEndsWith ?? "");
    if (same) continue;
    yield* eventgrid.EventSubscriptionsCreateOrUpdate({
      ...where,
      properties: {
        destination: {
          endpointType: "AzureFunction",
          properties: { resourceId, maxEventsPerBatch: 1 },
        },
        filter: {
          includedEventTypes: sub.includedEventTypes,
          subjectBeginsWith: sub.subjectBeginsWith,
          subjectEndsWith: sub.subjectEndsWith,
        },
        eventDeliverySchema: "EventGridSchema",
      },
    });
    yield* waitForProvisioned(
      `event subscription ${sub.name}`,
      orUndefinedIfNotFound(eventgrid.GetEventSubscription(where)),
      (s) => s.properties?.provisioningState,
      { interval: "5 seconds", times: 36 },
    );
  }
  const keep = new Set(options.desired.map((s) => `${s.scope.toLowerCase()}|${s.name}`));
  for (const stale of options.previous) {
    if (keep.has(`${stale.scope.toLowerCase()}|${stale.name}`)) continue;
    yield* ignoreNotFound(
      eventgrid.DeleteEventSubscription({ scope: stale.scope, eventSubscriptionName: stale.name }),
    );
  }
  return options.desired.map((s) => ({ scope: s.scope, name: s.name }));
});
