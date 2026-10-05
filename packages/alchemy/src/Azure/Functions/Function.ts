import * as web from "@distilled.cloud/azure/web";
import { Credentials } from "@distilled.cloud/azure";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import { safeHttpEffect, type HttpEffect } from "../../Http.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { packEnvValue } from "../../RuntimeContext.ts";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { zipFiles } from "../../Util/zip.ts";
import { ignoreNotFound, orUndefinedIfNotFound } from "../Arm.ts";
import {
  registerAzureHostType,
  type AzureBindingContract,
} from "../Binding.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export const FunctionTypeId = "Azure.Functions.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

// Azure capability bindings (`bindAzureHost`) apply to this host type.
registerAzureHostType(FunctionTypeId);

/**
 * A native Azure Functions trigger binding (one `function.json` binding
 * with `direction: "in"`), e.g. `{ type: "timerTrigger", schedule: "..." }`.
 */
export type TriggerBinding = { type: string } & Record<string, unknown>;

/** A non-HTTP function registered by an event source. */
export interface FunctionTrigger {
  /** Function name — also the path the host POSTs invocations to. */
  name: string;
  /** The trigger binding written to `{name}/function.json`. */
  binding: TriggerBinding;
}

/**
 * Binding contract accepted by `Azure.Functions.Function`.
 *
 * `env` becomes app settings. `functions` are native trigger functions
 * contributed by event sources (`Timer`, `StorageQueue`).
 * `roleAssignments` (from the shared `AzureBindingContract`) are granted
 * to the function app's system-assigned identity, which must be enabled
 * (`identity: { type: "SystemAssigned" }` on the `Azure.Web.FunctionApp`).
 */
export interface FunctionBindingContract extends AzureBindingContract {
  functions?: FunctionTrigger[];
}

/** Payload the Functions host POSTs for a non-HTTP trigger invocation. */
export interface TriggerInvocation {
  /** Trigger data keyed by binding name (`"trigger"` for alchemy sources). */
  Data: Record<string, unknown>;
  /** Trigger metadata (dequeue count, schedule status, …). */
  Metadata: Record<string, unknown>;
}

export type TriggerHandler = (
  invocation: TriggerInvocation,
) => Effect.Effect<void, never, any>;

export interface FunctionProps extends PlatformProps {
  /** Entry module of the Effect-native program; bundled for Node.js. */
  main: string;
  /**
   * Named export of `main` that holds the program.
   * @default "default"
   */
  handler?: string;
  /** Rolldown bundle overrides. */
  build?: Bundle.BundleConfig;
  /** Resource group of the target function app. */
  resourceGroup: string;
  /**
   * Name of an existing function app (see `Azure.Web.FunctionApp`) created
   * with `runtime: { name: "custom" }`. Its code and the app settings named
   * in `env` are owned by this resource.
   */
  functionAppName: string;
  /** Extra app settings (merged with binding-contributed env). */
  env?: Record<string, any>;
}

export interface Function extends Resource<
  FunctionTypeId,
  FunctionProps,
  {
    /** Name of the function app the program is deployed to. */
    functionAppName: string;
    /** Resource group of the function app. */
    resourceGroup: string;
    /** Public HTTPS URL of the program. */
    url: string;
    /** Hash of the deployed package (bundle + function.json set). */
    codeHash: string;
    /** App-setting keys this resource wrote (removed on delete). */
    settingKeys: string[];
  },
  FunctionBindingContract,
  Providers
> {}

export type FunctionServices = Credentials | AzureEnvironment | ServerHost;
export type FunctionShape = Main<FunctionServices>;

/** Runtime context of an Azure Functions host. */
export interface FunctionRuntimeContext extends HostRuntimeContext {
  /**
   * Register a native trigger function `name` handled by `handler`.
   * At deploy time it binds the function definition onto the host; at
   * runtime it routes the host's `POST /{name}` invocations to `handler`.
   */
  trigger: (
    name: string,
    binding: TriggerBinding,
    handler: TriggerHandler,
  ) => Effect.Effect<void>;
}

const createFunctionRuntimeContext = (id: string): FunctionRuntimeContext => {
  const base = createContainerRuntimeContext(FunctionTypeId)(id);
  const triggers = new Map<string, TriggerHandler>();
  const serveBase = base.serve;
  const ctx: FunctionRuntimeContext = Object.assign(base, {
    serve: ((handler, options) =>
      serveBase(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const name = new URL(request.url, "http://localhost").pathname.slice(
            1,
          );
          const trigger =
            request.method === "POST" ? triggers.get(name) : undefined;
          if (trigger === undefined) {
            return yield* safeHttpEffect(handler);
          }
          const body = yield* request.json.pipe(
            Effect.orElseSucceed(() => ({})),
          );
          const record =
            typeof body === "object" && body !== null
              ? (body as Partial<TriggerInvocation>)
              : {};
          yield* trigger({
            Data: record.Data ?? {},
            Metadata: record.Metadata ?? {},
          });
          return yield* HttpServerResponse.json({
            Outputs: {},
            Logs: [],
            ReturnValue: null,
          }).pipe(Effect.orDie);
        }) as HttpEffect<any>,
        options,
      )) as HostRuntimeContext["serve"],
    trigger: (name: string, binding: TriggerBinding, handler: TriggerHandler) =>
      Effect.sync(() => {
        triggers.set(name, handler);
      }),
  });
  return ctx;
};

/**
 * An Effect-native program hosted on Azure Functions.
 *
 * Alchemy bundles `main` for Node.js and zip-deploys it (Kudu OneDeploy) to
 * an existing function app as a
 * [custom handler](https://learn.microsoft.com/azure/azure-functions/functions-custom-handlers):
 * a catch-all `httpTrigger` forwards every request to the program's `fetch`,
 * and event sources add native trigger functions (`timerTrigger`,
 * `queueTrigger`) whose invocations the Functions host POSTs to the program.
 * Bindings contribute `env`, which becomes app settings.
 *
 * Create the function app with `Azure.Web.FunctionApp` and
 * `runtime: { name: "custom" }` (Flex Consumption or any Linux plan), and
 * avoid setting `appSettings` there for keys this resource owns.
 *
 * ### Hosting an HTTP program
 * **Example:** Effect HTTP handler on a function app
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     resourceGroup: rg.resourceGroupName,
 *     functionAppName: app.siteName,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Event sources
 * **Example:** Run on a schedule
 * ```typescript
 * yield* Azure.Functions.schedule("nightly", "0 0 3 * * *", () =>
 *   Effect.log("tick"),
 * );
 * ```
 *
 * @resource
 * @category Functions
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  FunctionRuntimeContext,
  {},
  FunctionProps
> = Platform(FunctionTypeId, {
  createRuntimeContext: createFunctionRuntimeContext,
});

export class FunctionDeployFailed extends Data.TaggedError(
  "Azure.Functions.FunctionDeployFailed",
)<{ status: number; message: string }> {}

const HOST_JSON = `${JSON.stringify(
  {
    version: "2.0",
    customHandler: {
      description: {
        defaultExecutablePath: "node",
        arguments: ["index.mjs"],
      },
      enableForwardingHttpRequest: true,
    },
    extensions: { http: { routePrefix: "" } },
    extensionBundle: {
      id: "Microsoft.Azure.Functions.ExtensionBundle",
      version: "[4.*, 5.0.0)",
    },
  },
  null,
  2,
)}\n`;

const HTTP_FUNCTION_JSON = `${JSON.stringify(
  {
    bindings: [
      {
        type: "httpTrigger",
        direction: "in",
        name: "req",
        authLevel: "anonymous",
        methods: ["get", "post", "put", "patch", "delete", "head", "options"],
        route: "{*path}",
      },
      { type: "http", direction: "out", name: "res" },
    ],
  },
  null,
  2,
)}\n`;

/** The bundle's entry: raises the runtime flag, then runs the program. */
const makeBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "alchemy/Runtime/Bootstrap/AzureFunctions";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

const bundleProgram = Effect.fn(function* (
  props: FunctionProps,
  triggers: FunctionTrigger[],
) {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* resolveMainPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const output = yield* Bundle.build(
    {
      ...props.build?.input,
      input: realMain,
      cwd,
      platform: "node",
      resolve: {
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        ...props.build?.input?.resolve,
      },
      plugins: [
        props.build?.input?.plugins,
        props.isExternal
          ? undefined
          : virtualEntryPlugin(makeBootstrap(props.handler ?? "default")),
      ],
    },
    {
      ...props.build?.output,
      format: "esm",
      sourcemap: props.build?.output?.sourcemap ?? false,
      entryFileNames: "index.mjs",
    },
    props.build,
  );
  const functionJsons = triggers.map((t) => ({
    path: `${t.name}/function.json`,
    content: `${JSON.stringify({
      bindings: [{ ...t.binding, direction: "in", name: "trigger" }],
    })}\n`,
  }));
  const files = [
    ...output.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content,
    })),
    { path: "host.json", content: HOST_JSON },
    { path: "http/function.json", content: HTTP_FUNCTION_JSON },
    { path: "package.json", content: '{"type":"module"}\n' },
    ...functionJsons,
  ];
  const codeHash = (yield* sha256Object({
    bundle: output.hash,
    functions: functionJsons,
    host: HOST_JSON,
  })).slice(0, 16);
  return { files, codeHash };
});

/** `name.region.azurewebsites.net` → `name.scm.region.azurewebsites.net`. */
const scmHostOf = (defaultHostName: string) => {
  const [first, ...rest] = defaultHostName.split(".");
  return [first, "scm", ...rest].join(".");
};

const envString = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const collectBindings = (
  bindings: ResourceBinding<FunctionBindingContract>[],
) => {
  const env: Record<string, any> = {};
  const functions = new Map<string, FunctionTrigger>();
  const roleAssignments: { roleDefinitionId: string; scope: string }[] = [];
  const active = bindings.filter(
    (b: ResourceBinding<FunctionBindingContract> & { action?: string }) =>
      b.action !== "delete",
  );
  for (const b of active) {
    roleAssignments.push(...(b.data.roleAssignments ?? []));
    Object.assign(env, b.data.env ?? {});
    for (const f of b.data.functions ?? []) functions.set(f.name, f);
  }
  return {
    env,
    roleAssignments,
    functions: [...functions.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
};

export const FunctionProvider = () =>
  Provider.succeed(Function, {
    stables: ["functionAppName", "resourceGroup"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        olds !== undefined &&
        (olds.functionAppName !== news.functionAppName ||
          olds.resourceGroup !== news.resourceGroup)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        name: news.functionAppName,
      };

      // Observe the function app (it must already exist).
      const site = yield* web.GetWebApp(where);
      const defaultHostName = site.properties?.defaultHostName;
      if (defaultHostName === undefined) {
        return yield* new FunctionDeployFailed({
          status: 0,
          message: `function app ${news.functionAppName} has no defaultHostName`,
        });
      }

      const collected = collectBindings(
        bindings as ResourceBinding<FunctionBindingContract>[],
      );

      // Grant binding roles to the app's system-assigned identity.
      const principalId = site.identity?.principalId;
      if (principalId !== undefined) {
        yield* syncBindingAssignments({
          id,
          subscriptionId,
          appId: site.id ?? news.functionAppName,
          principalId,
          grants: collected.roleAssignments,
        });
      } else if (collected.roleAssignments.length > 0) {
        return yield* new FunctionDeployFailed({
          status: 0,
          message: `function app ${news.functionAppName} needs a system-assigned identity for binding role assignments`,
        });
      }

      // Sync app settings: overlay the desired keys onto the observed set,
      // dropping keys this resource wrote before but no longer wants.
      const desired: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...collected.env,
        ...news.env,
      })) {
        if (value !== undefined) desired[key] = envString(packEnvValue(value));
      }
      const observed =
        (yield* web.ListWebAppApplicationSettings(where)).properties ?? {};
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(observed)) {
        if (v !== undefined) next[k] = v;
      }
      for (const key of output?.settingKeys ?? []) {
        if (!(key in desired)) delete next[key];
      }
      Object.assign(next, desired);
      const changed =
        Object.keys(next).length !== Object.keys(observed).length ||
        Object.entries(next).some(([k, v]) => observed[k] !== v);
      if (changed) {
        yield* web.UpdateWebAppApplicationSettings({
          ...where,
          properties: next,
        });
      }

      // Bundle and zip-deploy when the package changed.
      const { files, codeHash } = yield* bundleProgram(
        news,
        collected.functions,
      );
      if (output?.codeHash !== codeHash || changed) {
        const archive = yield* zipFiles(files);
        const credentials = yield* yield* Credentials;
        const http = yield* HttpClient.HttpClient;
        const response = yield* http
          .execute(
            HttpClientRequest.post(
              `https://${scmHostOf(defaultHostName)}/api/publish?RemoteBuild=false&Deployer=alchemy`,
            ).pipe(
              HttpClientRequest.bearerToken(
                Redacted.value(credentials.bearerToken),
              ),
              HttpClientRequest.bodyUint8Array(
                new Uint8Array(archive),
                "application/zip",
              ),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new FunctionDeployFailed({ status: 0, message: String(cause) }),
            ),
          );
        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new FunctionDeployFailed({
            status: response.status,
            message: text.slice(0, 500),
          });
        }
      }

      return {
        functionAppName: news.functionAppName,
        resourceGroup: news.resourceGroup,
        url: `https://${defaultHostName}`,
        codeHash,
        settingKeys: Object.keys(desired).sort(),
      };
    }),

    // The deployed package lives and dies with the function app; only the
    // app settings this resource wrote are removed.
    delete: Effect.fn(function* ({ id, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        name: output.functionAppName,
      };
      const site = yield* orUndefinedIfNotFound(web.GetWebApp(where));
      if (site === undefined) return;
      const principalId = site.identity?.principalId;
      if (principalId !== undefined) {
        yield* syncBindingAssignments({
          id,
          subscriptionId,
          appId: site.id ?? output.functionAppName,
          principalId,
          grants: [],
        });
      }
      if (output.settingKeys.length === 0) return;
      const observed = yield* web.ListWebAppApplicationSettings(where).pipe(
        Effect.map((s) => s.properties ?? {}),
        orUndefinedIfNotFound,
      );
      if (observed === undefined) return;
      const next = { ...observed };
      for (const key of output.settingKeys) delete next[key];
      yield* web
        .UpdateWebAppApplicationSettings({ ...where, properties: next })
        .pipe(ignoreNotFound);
    }),
  });
