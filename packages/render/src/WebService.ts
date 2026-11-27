import * as RenderSdk from "@distilled.cloud/render";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
  MaintenanceMode,
  OpenPortInfo,
  RenderSubdomainPolicy,
  ServicePlan,
} from "./Types.ts";

export interface WebServiceProps extends LongRunningServiceProps {
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
}

export interface WebServiceLookup {
  /** Look up an existing web service by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing web service by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Web Service accepts public HTTP/HTTPS traffic over an `onrender.com`
 * or custom domain, supports autoscaling, persistent disks, health checks, and
 * accepts runtime bindings (`ConnectPostgres`, `ReadWriteKeyValue`, etc.).
 *
 * **Example:** Node web service bound to Postgres
 * ```typescript
 * const api = yield* Render.WebService("Api", {
 *   name: "my-api",
 *   plan: "starter",
 *   region: "oregon",
 *   environmentId: env.id,
 *   healthCheckPath: "/healthz",
 *   runtimeSource: {
 *     nativeRuntime: {
 *       runtime: "node",
 *       repo: "https://github.com/org/repo",
 *       branch: "main",
 *       buildCommand: "pnpm install && pnpm build",
 *     },
 *   },
 *   startCommand: "pnpm start",
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export interface WebService extends Resource<
  "Render.WebService",
  WebServiceProps,
  WebServiceAttributes,
  RenderServiceBinding,
  Providers,
  WebServiceLookup
> {}

export const WebService = Resource<WebService>("Render.WebService");

/** Purge the edge/asset CDN cache for a Render web service (`POST /v1/services/{id}/cache/purge`). */
export const purgeServiceCache = (
  serviceId: string,
): Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof RenderSdk.purgeCache>>,
  Effect.Services<ReturnType<typeof RenderSdk.purgeCache>>
> => RenderSdk.purgeCache({ serviceId }).pipe(Effect.asVoid);

const mapWebService = (data: HydratedServiceData): WebServiceAttributes => {
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
  };
};

export const WebServiceProvider = () =>
  Provider.effect(
    WebService,
    Effect.succeed({
      stables: ["id", "slug"],
      nuke: {
        dependsOn: [
          "Render.Environment",
          "Render.Project",
          "Render.RegistryCredential",
          "Render.EnvGroup",
        ],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (news.region !== undefined && olds.region !== undefined && news.region !== olds.region) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
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
          toAttributes: mapWebService,
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
        return yield* precreateLongRunningService<WebServiceProps, WebServiceAttributes>({
          resourceType: "Render.WebService",
          serviceType: "web_service",
          id,
          news,
          defaultPlan: "starter",
          toAttributes: mapWebService,
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
        return all.map(mapWebService);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        return yield* reconcileLongRunningService<WebServiceProps, WebServiceAttributes>({
          resourceType: "Render.WebService",
          serviceType: "web_service",
          id,
          news,
          olds,
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
          toAttributes: mapWebService,
        });
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* deleteServiceById(output.id);
      }),
    }),
  );
