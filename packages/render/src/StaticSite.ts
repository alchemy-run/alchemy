import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "./internal/Client.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import { toRedacted } from "./internal/Redacted.ts";
import {
  buildIpAllowListField,
  envVarsToWire,
  findServiceByLookup,
  hydrateService,
  listServicesByType,
  mapCustomDomains,
  mergeBoundEnvVars,
  readServiceForProvider,
  syncCustomDomains,
  syncNotificationOverride,
  syncResourceLogStream,
  syncServiceSuspension,
  waitForServiceLive,
  type HydratedServiceData,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type {
  AutoDeployTrigger,
  BuildFilter,
  BuildPlan,
  CidrBlockAndDescription,
  CustomDomainInfo,
  EnvVarValueSpec,
  LogStreamOverrideAttributes,
  LogStreamOverrideInput,
  NotificationOverrideConfig,
  PreviewsConfig,
  RenderSubdomainPolicy,
  StaticSiteHeaderAttributes,
  StaticSiteHeaderInput,
  StaticSiteRouteAttributes,
  StaticSiteRouteInput,
} from "./Types.ts";

export interface StaticSiteProps {
  /** Static site name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Render project environment ID (`env-...`) to associate the static site with. */
  environmentId?: string;
  /** Git repository URL. */
  repo: string;
  /** Git branch to build and publish. */
  branch: string;
  /** Repository subdirectory relative to root where `buildCommand` runs. */
  rootDirectory?: string;
  /** Shell command to build static assets. */
  buildCommand: string;
  /** Publish directory relative to repo/root directory. Defaults to `"public"`. */
  publishPath?: string;
  /** Enable automatic deploys on push. Defaults to `true`. */
  autoDeploy?: boolean;
  /** Granular auto-deploy trigger (`"commit"`, `"checksPass"`, or `"off"`). */
  autoDeployTrigger?: AutoDeployTrigger;
  /** Optional build path filters. */
  buildFilter?: BuildFilter;
  /** Environment variables available during build. */
  envVars?: Record<string, EnvVarValueSpec>;
  /** Custom HTTP response headers scoped to URL paths. */
  headers?: StaticSiteHeaderInput[];
  /** Redirect and rewrite routing rules applied to requests. */
  routes?: StaticSiteRouteInput[];
  /** Custom domain names attached to this static site. */
  customDomains?: string[];
  /** Trigger Render DNS verification on configured custom domains during reconcile. */
  verifyCustomDomains?: boolean;
  /** Build tier (`"starter"` or `"performance"`). */
  buildPlan?: BuildPlan;
  /** Suspend (`true`) or resume (`false`) the static site. */
  suspended?: boolean;
  /** IPv4 CIDR blocks permitted to access the static site. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Controls whether `<slug>.onrender.com` subdomains are active. */
  renderSubdomainPolicy?: RenderSubdomainPolicy;
  /** Pull request preview settings. */
  previews?: PreviewsConfig;
  /** Legacy pull request previews toggle (prefer `previews.generation`). */
  pullRequestPreviewsEnabled?: boolean;
  /** Deploy notification overrides scoped to this site. */
  notificationOverride?: NotificationOverrideConfig;
  /** Log stream override (`send` or `drop`) scoped to this site. */
  logStreamOverride?: LogStreamOverrideInput;
  /** Skip triggering a manual deploy after in-place updates. */
  skipDeployAfterUpdate?: boolean;
  /** Wait for the latest deploy to reach `"live"` during reconcile. */
  waitForDeployCompletion?: boolean;
}

export interface StaticSiteAttributes {
  /** Render static site service ID (`srv-...`). */
  id: string;
  /** Static site name. */
  name: string;
  /** Unique slug assigned by Render. */
  slug: string;
  /** Owner workspace/user ID. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Public static site URL. */
  url?: string;
  /** Configured git repository URL. */
  repo?: string;
  /** Configured git branch. */
  branch?: string;
  /** Root directory relative to repository root. */
  rootDirectory?: string;
  /** Build command. */
  buildCommand?: string;
  /** Publish output directory path. */
  publishPath?: string;
  /** Build tier used for static site builds. */
  buildPlan?: string;
  /** Suspension status (`"suspended"` or `"not_suspended"`). */
  suspended: string;
  /** Auto-deploy enabled flag. */
  autoDeploy: boolean;
  /** Granular auto-deploy trigger. */
  autoDeployTrigger?: string;
  /** Path filters controlling auto-deploys. */
  buildFilter?: BuildFilter;
  /** Redacted build environment variables. */
  envVars: Record<string, Redacted.Redacted<string>>;
  /** Configured HTTP header rules. */
  headers: StaticSiteHeaderAttributes[];
  /** Configured redirect and rewrite rules. */
  routes: StaticSiteRouteAttributes[];
  /** Custom domains configured on the site. */
  customDomains: CustomDomainInfo[];
  /** Effective IP allow list. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Subdomain policy (`"enabled"` or `"disabled"`). */
  renderSubdomainPolicy?: RenderSubdomainPolicy;
  /** Pull request preview settings. */
  previews?: PreviewsConfig;
  /** Notification override state. */
  notificationOverride?: {
    notificationsToSend: string;
    previewNotificationsEnabled: string;
  };
  /** Log stream override state. */
  logStreamOverride?: LogStreamOverrideAttributes;
  /** Render Dashboard URL. */
  dashboardUrl: string;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface StaticSiteLookup {
  /** Look up an existing static site by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing static site by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Static Site builds a static bundle from a Git repository and
 * serves it over Render's global CDN with custom headers, redirect/rewrite
 * routes, custom domains, and IP allow lists.
 *
 * **Example:** Static site with SPA rewrite and cache headers
 * ```typescript
 * const web = yield* Render.StaticSite("Web", {
 *   name: "marketing-site",
 *   repo: "https://github.com/org/web",
 *   branch: "main",
 *   buildCommand: "pnpm build",
 *   publishPath: "dist",
 *   headers: [{ path: "/assets/*", name: "Cache-Control", value: "public, max-age=31536000" }],
 *   routes: [{ source: "/*", destination: "/index.html", type: "rewrite" }],
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export interface StaticSite extends Resource<
  "Render.StaticSite",
  StaticSiteProps,
  StaticSiteAttributes,
  RenderServiceBinding,
  Providers,
  StaticSiteLookup
> {}

export const StaticSite = Resource<StaticSite>("Render.StaticSite");

const hydrateAndMapStaticSite = (data: HydratedServiceData) =>
  Effect.gen(function* () {
    const s = data.service;
    const d = s.serviceDetails;
    const headers = yield* Client.listHeaders(s.id);
    const routes = yield* Client.listRoutes(s.id);
    const envVars: Record<string, Redacted.Redacted<string>> = {};
    for (const ev of data.envVars) {
      envVars[ev.key] = toRedacted(ev.value);
    }
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      ownerId: s.ownerId,
      environmentId: s.environmentId,
      url: d.url,
      repo: s.repo,
      branch: s.branch,
      rootDirectory: s.rootDir,
      buildCommand: d.buildCommand,
      publishPath: d.publishPath,
      buildPlan: d.buildPlan,
      suspended: s.suspended,
      autoDeploy: s.autoDeploy === "yes",
      autoDeployTrigger: s.autoDeployTrigger,
      buildFilter: s.buildFilter,
      envVars,
      headers: headers.map((h) => ({ id: h.id, path: h.path, name: h.name, value: h.value })),
      routes: routes.map((r) => ({
        id: r.id,
        source: r.source,
        destination: r.destination,
        type: r.type,
        priority: r.priority,
      })),
      customDomains: mapCustomDomains(data.customDomains),
      ipAllowList: d.ipAllowList,
      renderSubdomainPolicy: d.renderSubdomainPolicy,
      previews: d.previews,
      notificationOverride: data.notificationOverride
        ? {
            notificationsToSend: data.notificationOverride.notificationsToSend,
            previewNotificationsEnabled: data.notificationOverride.previewNotificationsEnabled,
          }
        : undefined,
      logStreamOverride: data.logStreamOverride?.setting
        ? {
            resourceId: data.logStreamOverride.resourceId ?? s.id,
            setting: data.logStreamOverride.setting,
            endpoint: data.logStreamOverride.endpoint,
          }
        : undefined,
      dashboardUrl: s.dashboardUrl,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    } satisfies StaticSiteAttributes;
  });

export const StaticSiteProvider = () =>
  Provider.effect(
    StaticSite,
    Effect.succeed({
      stables: ["id", "slug"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project", "Render.EnvGroup"],
      },
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        return yield* readServiceForProvider({
          serviceType: "static_site",
          id,
          olds,
          output,
          previous,
          toAttributes: hydrateAndMapStaticSite,
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
        const hydrated = yield* findServiceByLookup("static_site", props);
        return hydrated ? yield* hydrateAndMapStaticSite(hydrated) : undefined;
      }),
      list: Effect.fn(function* () {
        const all = yield* listServicesByType("static_site");
        return yield* Effect.forEach(all, hydrateAndMapStaticSite);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getService(output.id))
          : undefined;
        const mergedEnv = mergeBoundEnvVars(
          news.envVars,
          bindings.map((b) => b.data),
        );

        const autoDeployPart: Record<string, unknown> =
          news.autoDeployTrigger !== undefined
            ? { autoDeployTrigger: news.autoDeployTrigger }
            : { autoDeploy: news.autoDeploy === false ? "no" : "yes" };

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const envVarsWire = envVarsToWire(mergedEnv, [], false);
          const createdRes = yield* Client.createService({
            name: desiredName,
            ownerId,
            type: "static_site",
            repo: news.repo,
            branch: news.branch,
            ...autoDeployPart,
            ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
            ...(news.buildFilter !== undefined
              ? {
                  buildFilter: {
                    paths: news.buildFilter.paths ?? [],
                    ignoredPaths: news.buildFilter.ignoredPaths ?? [],
                  },
                }
              : {}),
            ...(envVarsWire.length > 0 ? { envVars: envVarsWire } : {}),
            serviceDetails: {
              buildCommand: news.buildCommand,
              publishPath: news.publishPath ?? "public",
              ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
              ...(news.headers !== undefined ? { headers: news.headers } : {}),
              ...(news.routes !== undefined ? { routes: news.routes } : {}),
              ...(news.ipAllowList !== undefined ? { ipAllowList: news.ipAllowList } : {}),
              ...(news.renderSubdomainPolicy !== undefined
                ? { renderSubdomainPolicy: news.renderSubdomainPolicy }
                : {}),
              ...(news.previews !== undefined
                ? { previews: { generation: news.previews.generation ?? "off" } }
                : {}),
              ...(news.pullRequestPreviewsEnabled !== undefined
                ? { pullRequestPreviewsEnabled: news.pullRequestPreviewsEnabled ? "yes" : "no" }
                : {}),
            },
          });

          const service = createdRes.service
            ? createdRes.service
            : yield* Client.listServices({
                ownerId: [ownerId],
                name: [desiredName],
                type: ["static_site"],
              }).pipe(Effect.map((rows) => rows[0]));

          if (news.environmentId !== undefined) {
            yield* Client.syncResourceEnvironment(
              service.id,
              service.environmentId,
              news.environmentId,
            );
          }
          if (news.customDomains && news.customDomains.length > 0) {
            yield* syncCustomDomains(service.id, [], news.customDomains, news.verifyCustomDomains);
          }
          if (news.notificationOverride) {
            yield* syncNotificationOverride(service.id, news.notificationOverride, false);
          }
          if (news.logStreamOverride) {
            yield* syncResourceLogStream(service.id, undefined, news.logStreamOverride);
          }
          yield* syncServiceSuspension(service.id, service.suspended, news.suspended);
          if (news.waitForDeployCompletion) {
            yield* waitForServiceLive("Render.StaticSite", service.id);
          }
          const fresh = yield* Client.getService(service.id);
          return yield* hydrateAndMapStaticSite(yield* hydrateService(fresh));
        }

        const hydratedBefore = yield* hydrateService(existing);
        const ipAllowList = buildIpAllowListField(news.ipAllowList, olds?.ipAllowList);

        yield* Client.updateService(existing.id, {
          name: desiredName,
          repo: news.repo,
          branch: news.branch,
          ...autoDeployPart,
          ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
          ...(news.buildFilter !== undefined
            ? {
                buildFilter: {
                  paths: news.buildFilter.paths ?? [],
                  ignoredPaths: news.buildFilter.ignoredPaths ?? [],
                },
              }
            : {}),
          serviceDetails: {
            buildCommand: news.buildCommand,
            publishPath: news.publishPath ?? "public",
            ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
            ...(ipAllowList !== undefined ? { ipAllowList } : {}),
            ...(news.renderSubdomainPolicy !== undefined
              ? { renderSubdomainPolicy: news.renderSubdomainPolicy }
              : {}),
            ...(news.previews !== undefined
              ? { previews: { generation: news.previews.generation ?? "off" } }
              : {}),
            ...(news.pullRequestPreviewsEnabled !== undefined
              ? { pullRequestPreviewsEnabled: news.pullRequestPreviewsEnabled ? "yes" : "no" }
              : {}),
          },
        });

        yield* Client.putServiceEnvVars(
          existing.id,
          envVarsToWire(mergedEnv, hydratedBefore.envVars, true),
        );
        if (news.headers !== undefined || olds?.headers !== undefined) {
          yield* Client.putHeaders(existing.id, news.headers ?? []);
        }
        if (news.routes !== undefined || olds?.routes !== undefined) {
          yield* Client.putRoutes(existing.id, news.routes ?? []);
        }
        yield* syncCustomDomains(
          existing.id,
          hydratedBefore.customDomains,
          news.customDomains,
          news.verifyCustomDomains,
        );
        yield* syncNotificationOverride(
          existing.id,
          news.notificationOverride,
          hydratedBefore.notificationOverride !== undefined,
        );
        yield* syncResourceLogStream(
          existing.id,
          hydratedBefore.logStreamOverride,
          news.logStreamOverride,
        );
        yield* Client.syncResourceEnvironment(
          existing.id,
          existing.environmentId,
          news.environmentId,
        );
        yield* syncServiceSuspension(existing.id, existing.suspended, news.suspended);

        if (!news.skipDeployAfterUpdate) {
          yield* Client.createDeploy(existing.id);
        }
        if (news.waitForDeployCompletion) {
          yield* waitForServiceLive("Render.StaticSite", existing.id);
        }

        const refreshed = yield* Client.getService(existing.id);
        return yield* hydrateAndMapStaticSite(yield* hydrateService(refreshed));
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteService(output.id);
      }),
    }),
  );
