import { DockerLive, type RegistryCredentials } from "@alchemy.run/docker/Docker";
import { makeContainerImageSource, type ImageSourceLike } from "@alchemy.run/docker/ImageSource";
import * as RenderSdk from "@distilled.cloud/render";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { Resource, type LookupMethod } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { envString, unwrapRedactedMarker } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RenderValidationError } from "./Errors.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import {
  buildIpAllowListField,
  deleteServiceById,
  findServiceByLookup,
  listServicesByType,
  mapBaseServiceAttrs,
  mapCustomDomains,
  observeServiceForProvider,
  pickMaintenanceMode,
  pickRenderSubdomainPolicy,
  precreateLongRunningService,
  readServiceForProvider,
  reconcileLongRunningService,
  type HydratedServiceData,
  type LongRunningServiceProps,
  type ServiceAttributes,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type {
  CacheProfile,
  CidrBlockAndDescription,
  CustomDomainInfo,
  EnvVarValueSpec,
  MaintenanceMode,
  OpenPortInfo,
  RenderSubdomainPolicy,
  RuntimeSource,
  ServicePlan,
} from "./Types.ts";

const DEFAULT_PORT = 10000;

export interface WebServiceProps
  extends Omit<LongRunningServiceProps, "runtimeSource">, PlatformProps {
  /**
   * Source code or container image configuration (`nativeRuntime`, `docker`, or
   * `image`). Omit when providing `main`, `context`, or `image` directly.
   */
  runtimeSource?: RuntimeSource;
  /**
   * Module entrypoint bundled with rolldown and baked into a container image
   * pushed to {@link registryImage}. Typically `import.meta.url` for Effect
   * programs, or a path to an async `{ fetch(request, env) }` handler module.
   */
  main?: string;
  /** Named export loaded from {@link main}. @default "default" */
  handler?: string;
  /** Port the hosted HTTP server listens on. Written to `PORT`. @default 10000 */
  port?: number;
  /**
   * Environment variables passed into the hosted process (and usable with
   * `Render.InferEnv<typeof ...>`). Merged before {@link envVars}.
   */
  env?: Record<string, any>;
  /** Docker build context directory when building an image without `main`. */
  context?: string;
  /** Dockerfile path relative to cwd (or inline Dockerfile) for {@link context} or {@link main}. */
  dockerfile?: ImageSourceLike["dockerfile"];
  /** Container image reference when running a pre-built image directly or overriding the base image for {@link main}. */
  image?: string;
  /** Bundler / Docker build options when building from {@link main} or {@link context}. */
  build?: ImageSourceLike["build"];
  /** Extra files or directories copied next to a bundled {@link main} inside `/app`. */
  extraFiles?: ImageSourceLike["extraFiles"];
  /** @internal Run an unbundled standalone Node program listening on `PORT`. */
  standalone?: boolean;
  /** @internal Packages installed into a `standalone` image instead of bundled. */
  packages?: ImageSourceLike["packages"];
  /**
   * OCI repository URI (`ghcr.io/org/app` or Docker Hub repo) to push images built
   * from {@link main} or {@link context}. Required when {@link main} or {@link context} is set.
   */
  registryImage?: string;
  /** Render `RegistryCredential` ID (`rgc-...`) used by Render to pull private images from {@link registryImage}. */
  registryCredentialId?: string;
  /** Optional Docker push credentials for {@link registryImage}. Defaults to the local Docker configuration. */
  registryCredentials?: RegistryCredentials;
  /** Instance plan (`"starter"`, `"standard"`, `"pro"`, `"pro_plus"`, `"free"`, etc.). */
  plan?: ServicePlan;
  /** HTTP path checked by Render for health monitoring and zero-downtime deploys. */
  healthCheckPath?: string;
  /** Custom domain names attached to the web service. */
  customDomains?: string[];
  /** Trigger Render DNS verification on configured custom domains during reconcile. */
  verifyCustomDomains?: boolean;
  /** Render edge cache profile (`"no-cache"`, `"origin-controlled"`, `"origin-controlled-all"`). */
  cacheProfile?: CacheProfile;
  /** IPv4 CIDR blocks allowed to reach the public service endpoint. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Maintenance mode settings (`enabled`, `uri`). */
  maintenanceMode?: MaintenanceMode;
  /** Controls whether `<slug>.onrender.com` subdomains remain active (`"enabled"` or `"disabled"`). */
  renderSubdomainPolicy?: RenderSubdomainPolicy;
}

export interface WebServiceAttributes extends ServiceAttributes {
  /** Public `onrender.com` URL assigned to the web service. */
  url?: string;
  /** Configured health check path. */
  healthCheckPath?: string;
  /** Open service ports reported by Render. */
  openPorts: OpenPortInfo[];
  /** Custom domains configured on this service. */
  customDomains: CustomDomainInfo[];
  /** Active edge cache profile, if configured. */
  cacheProfile?: CacheProfile;
  /** Effective IP allow list. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Effective maintenance mode configuration. */
  maintenanceMode?: MaintenanceMode;
  /** `onrender.com` subdomain policy (`"enabled"` or `"disabled"`). */
  renderSubdomainPolicy?: RenderSubdomainPolicy;
  /** Content hash of the bundled `main` / Docker build source when container-built. */
  code?: { hash: string };
}

export interface WebServiceLookup {
  /** Look up an existing web service by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing web service by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

export type WebServiceServices = ServerHost;

export type WebServiceShape = Main<WebServiceServices>;

export type WebServiceRuntimeContext = HostRuntimeContext;

/**
 * A Render Web Service accepts public HTTP/HTTPS traffic over an `onrender.com`
 * or custom domain, supports autoscaling, persistent disks, health checks, and
 * accepts runtime bindings (`ConnectPostgres`, `ReadWriteKeyValue`, etc.).
 *
 * ### Effect WebService
 * Deploy a bundled Effect HTTP server (built and pushed to `registryImage`):
 * ```typescript
 * // src/Api.ts
 * export default class Api extends Render.WebService<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registryImage: "ghcr.io/org/api",
 *     plan: "starter",
 *     region: "oregon",
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async WebService
 * Deploy a plain `{ fetch(request, env) }` handler with typed env via {@link InferEnv}:
 * ```typescript
 * // alchemy.run.ts
 * export const Ping = Render.WebService("Ping", {
 *   main: "./src/ping.ts",
 *   registryImage: "ghcr.io/org/ping",
 *   env: { GREETING: "hello" },
 * });
 * export type PingEnv = Render.InferEnv<typeof Ping>;
 * ```
 *
 * ```typescript
 * // src/ping.ts
 * import type { PingEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(_request: Request, env: PingEnv) {
 *     return new Response(env.GREETING);
 *   },
 * };
 * ```
 *
 * ### Git or Pre-Built Image WebService
 * Manage an existing Git repo or pre-built registry image on Render directly:
 * ```typescript
 * const api = yield* Render.WebService("Api", {
 *   name: "my-api",
 *   plan: "starter",
 *   region: "oregon",
 *   environmentId: env.id,
 *   healthCheckPath: "/healthz",
 *   runtimeSource: {
 *     image: { imagePath: "ghcr.io/org/api", tag: "latest" },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export type WebService = Resource<
  "Render.WebService",
  WebServiceProps,
  WebServiceAttributes,
  RenderServiceBinding,
  Providers,
  WebServiceLookup
>;

export const WebService: Platform<
  WebService,
  WebServiceServices,
  WebServiceShape,
  WebServiceRuntimeContext
> &
  LookupMethod<WebService> = Platform("Render.WebService", {
  createRuntimeContext: createHostRuntimeContext("Render.WebService"),
});

/** Purge the edge/asset CDN cache for a Render web service (`POST /v1/services/{id}/cache/purge`). */
export const purgeServiceCache = (
  serviceId: string,
): Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof RenderSdk.purgeCache>>,
  Effect.Services<ReturnType<typeof RenderSdk.purgeCache>>
> => RenderSdk.purgeCache({ serviceId }).pipe(Effect.asVoid);

const effectBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/render/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

const asyncBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { createServer } from "node:http";
import { Readable } from "node:stream";
import * as mod from ${JSON.stringify(importPath)};

const exported = mod[${JSON.stringify(handler)}];
const fetchHandler = typeof exported === "function" ? exported : exported?.fetch;
const port = Number(process.env.PORT ?? ${DEFAULT_PORT});

createServer(async (req, res) => {
  try {
    if (typeof fetchHandler !== "function") throw new Error("main exports no fetch handler");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else if (value !== undefined) headers.set(key, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(\`http://\${req.headers.host ?? "localhost"}\${req.url}\`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    const response = await fetchHandler(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  }
}).listen(port, "0.0.0.0");
`;

const imageOptions = (id: string, news: WebServiceProps) => {
  const handler = news.handler ?? "default";
  return {
    id,
    source: news as ImageSourceLike,
    port: news.port ?? DEFAULT_PORT,
    isExternal: news.standalone === true,
    bootstrap: news.isExternal ? asyncBootstrap(handler) : effectBootstrap(handler),
  };
};

const mergeWebServiceEnvVars = (
  env: Record<string, any> | undefined,
  envVars: Record<string, EnvVarValueSpec> | undefined,
  extras?: Record<string, string>,
): Record<string, EnvVarValueSpec> | undefined => {
  if (!env && !envVars && !extras) return undefined;
  const merged: Record<string, EnvVarValueSpec> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const plain = envString(value);
    if (plain !== undefined) {
      merged[key] = unwrapRedactedMarker(plain);
    }
  }
  for (const [key, value] of Object.entries(extras ?? {})) {
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(envVars ?? {})) {
    merged[key] = value;
  }
  return merged;
};

const mapWebService = (
  data: HydratedServiceData,
  code?: { hash: string },
): WebServiceAttributes => {
  const base = mapBaseServiceAttrs(data);
  const d = data.service.serviceDetails;
  const cacheProfile =
    "cache" in d && d.cache?.profile ? (d.cache.profile as CacheProfile) : undefined;
  return {
    ...base,
    url: "url" in d ? d.url : undefined,
    healthCheckPath: "healthCheckPath" in d ? d.healthCheckPath : undefined,
    openPorts: "openPorts" in d && d.openPorts ? d.openPorts : [],
    customDomains: mapCustomDomains(data.customDomains),
    cacheProfile,
    ipAllowList: "ipAllowList" in d ? d.ipAllowList : undefined,
    maintenanceMode: "maintenanceMode" in d ? d.maintenanceMode : undefined,
    renderSubdomainPolicy: "renderSubdomainPolicy" in d ? d.renderSubdomainPolicy : undefined,
    ...(code !== undefined ? { code } : {}),
  };
};

const toStaticRuntimeSource = (news: WebServiceProps): RuntimeSource | undefined => {
  if (news.runtimeSource !== undefined) return news.runtimeSource;
  if (news.image !== undefined) {
    return {
      image: {
        imagePath: news.image,
        ...(news.registryCredentialId !== undefined
          ? { registryCredentialId: news.registryCredentialId }
          : {}),
      },
    };
  }
  return undefined;
};

export const WebServiceProvider = () =>
  Provider.effect(
    WebService,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const images = yield* makeContainerImageSource;

      return {
        stables: ["id", "slug"],
        nuke: {
          dependsOn: [
            "Render.Environment",
            "Render.Project",
            "Render.RegistryCredential",
            "Render.EnvGroup",
          ],
        },
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (
            news.region !== undefined &&
            olds.region !== undefined &&
            news.region !== olds.region
          ) {
            const deleteFirst =
              typeof news.name === "string" && news.name === (output?.name ?? olds.name);
            return { action: "replace", deleteFirst } as const;
          }
          if (output !== undefined && (news.main !== undefined || news.context !== undefined)) {
            const hash = yield* images.hash(imageOptions(id, news));
            if (hash !== output.code?.hash) {
              return { action: "update" } as const;
            }
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          return yield* readServiceForProvider({
            serviceType: "web_service",
            id,
            olds,
            output,
            previous,
            toAttributes: (data) => mapWebService(data, output?.code),
          });
        }),
        observe: Effect.fn(function* ({ id, news, previous }) {
          return yield* observeServiceForProvider({
            serviceType: "web_service",
            id,
            news,
            previous,
          });
        }),
        precreate: Effect.fn(function* ({ id, news }) {
          const runtimeSource = toStaticRuntimeSource(news);
          if (!runtimeSource) {
            return yield* new RenderValidationError({
              field: "runtimeSource",
              message:
                "Render.WebService precreate for dependency cycles requires a resolved `runtimeSource` or `image`.",
            });
          }
          return yield* precreateLongRunningService<LongRunningServiceProps, WebServiceAttributes>({
            resourceType: "Render.WebService",
            serviceType: "web_service",
            id,
            news: {
              ...news,
              runtimeSource,
              envVars: mergeWebServiceEnvVars(news.env, news.envVars),
            },
            defaultPlan: "starter",
            toAttributes: (data) => mapWebService(data),
          });
        }),
        logs: Effect.fn(function* ({ output, options }) {
          return yield* renderResourceLogs({
            ownerId: output.ownerId,
            resourceId: output.id,
            options,
          });
        }),
        tail: ({ output }) =>
          renderResourceTail({
            ownerId: output.ownerId,
            resourceId: output.id,
          }),
        lookup: Effect.fn(function* (props) {
          const hydrated = yield* findServiceByLookup("web_service", props);
          return hydrated ? mapWebService(hydrated) : undefined;
        }),
        list: Effect.fn(function* () {
          const all = yield* listServicesByType("web_service");
          return all.map((data) => mapWebService(data));
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings, session }) {
          const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
          const usesContainerSource = news.main !== undefined || news.context !== undefined;

          let effectiveRuntimeSource: RuntimeSource | undefined = toStaticRuntimeSource(news);
          let code: { hash: string } | undefined;
          let runtimeEnvExtras: Record<string, string> | undefined;

          if (usesContainerSource) {
            if (!news.registryImage) {
              return yield* new RenderValidationError({
                field: "registryImage",
                message:
                  "Render.WebService requires `registryImage` (for example `ghcr.io/org/app`) when building from `main` or `context`, because Render does not host its own container registry.",
              });
            }
            const resolved = yield* images.resolve(
              { ...imageOptions(id, news), session },
              {
                repositoryUri: Effect.succeed(news.registryImage),
                hasTag: () => Effect.succeed(false),
                credentials: Effect.succeed(news.registryCredentials),
              },
            );
            code = { hash: resolved.codeHash };
            effectiveRuntimeSource = {
              image: {
                imagePath: resolved.imageUri,
                ...(news.registryCredentialId !== undefined
                  ? { registryCredentialId: news.registryCredentialId }
                  : {}),
              },
            };
            runtimeEnvExtras = {
              ALCHEMY_STACK_NAME: stack.name,
              ALCHEMY_STAGE: stack.stage,
              ALCHEMY_PHASE: "runtime",
              PORT: String(news.port ?? DEFAULT_PORT),
            };
          }

          if (!effectiveRuntimeSource) {
            return yield* new RenderValidationError({
              field: "runtimeSource",
              message:
                "Render.WebService requires one of `runtimeSource`, `main`, `context`, or `image`.",
            });
          }

          const staticOldRuntimeSource = olds ? toStaticRuntimeSource(olds) : undefined;
          const reconciled = yield* reconcileLongRunningService<
            WebServiceProps & { runtimeSource: RuntimeSource },
            WebServiceAttributes
          >({
            resourceType: "Render.WebService",
            serviceType: "web_service",
            id,
            news: {
              ...news,
              runtimeSource: effectiveRuntimeSource,
              envVars: mergeWebServiceEnvVars(news.env, news.envVars, runtimeEnvExtras),
            },
            olds:
              olds !== undefined
                ? {
                    ...olds,
                    runtimeSource: staticOldRuntimeSource ?? effectiveRuntimeSource,
                  }
                : undefined,
            output,
            desiredName,
            bindings: bindings.map((b) => b.data),
            defaultPlan: "starter",
            extraCreateDetails: (p) => {
              const maintenanceMode = pickMaintenanceMode(p.maintenanceMode, undefined);
              const renderSubdomainPolicy = pickRenderSubdomainPolicy(p.renderSubdomainPolicy);
              return {
                ...(p.healthCheckPath !== undefined ? { healthCheckPath: p.healthCheckPath } : {}),
                ...(p.cacheProfile !== undefined ? { cache: { profile: p.cacheProfile } } : {}),
                ...(p.ipAllowList !== undefined ? { ipAllowList: p.ipAllowList } : {}),
                ...(maintenanceMode !== undefined ? { maintenanceMode } : {}),
                ...(renderSubdomainPolicy !== undefined ? { renderSubdomainPolicy } : {}),
              };
            },
            extraUpdateDetails: (p, prev) => {
              const ipAllowList = buildIpAllowListField(p.ipAllowList, prev?.ipAllowList);
              const maintenanceMode = pickMaintenanceMode(p.maintenanceMode, prev?.maintenanceMode);
              const renderSubdomainPolicy = pickRenderSubdomainPolicy(p.renderSubdomainPolicy);
              return {
                ...(p.healthCheckPath !== undefined ? { healthCheckPath: p.healthCheckPath } : {}),
                ...(p.cacheProfile !== undefined ? { cache: { profile: p.cacheProfile } } : {}),
                ...(ipAllowList !== undefined ? { ipAllowList } : {}),
                ...(maintenanceMode !== undefined ? { maintenanceMode } : {}),
                ...(renderSubdomainPolicy !== undefined ? { renderSubdomainPolicy } : {}),
              };
            },
            extraDesiredCustomDomains: (p) => p.customDomains,
            extraVerifyCustomDomains: (p) => p.verifyCustomDomains,
            toAttributes: (data) => mapWebService(data, code),
          });
          return reconciled;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output?.id) return;
          yield* deleteServiceById(output.id);
        }),
      };
    }),
  ).pipe(Layer.provide(DockerLive));
