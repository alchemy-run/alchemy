import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { RenderNotFoundError } from "./Errors.ts";
import * as Client from "./internal/Client.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import { toRedacted } from "./internal/Redacted.ts";
import {
  envVarsToWire,
  hydrateService,
  mergeBoundEnvVars,
  waitForServiceLive,
  type HydratedServiceData,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type { EnvVarValueSpec, ServicePlan, ServiceType } from "./Types.ts";

export interface ServicePreviewProps {
  /** Base image-backed Render service ID (`srv-...`) to clone this preview instance from. Changing it replaces the preview. */
  baseServiceId: string;
  /** Container image path (full reference or relative tag/digest variation on the base service image). */
  imagePath: string;
  /** Preview service name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Compute plan for the preview instance (inherits base plan when omitted). */
  plan?: ServicePlan;
  /** Optional Render workspace/owner ID override for name lookup. */
  ownerId?: string;
  /** Environment variable overrides applied to the preview service after creation. */
  envVars?: Record<string, EnvVarValueSpec>;
  /** Wait until the preview service deploy reaches `"live"`. */
  waitForDeployCompletion?: boolean;
}

export interface ServicePreviewAttributes {
  /** Render service ID (`srv-...`) allocated to this preview instance. */
  id: string;
  /** Base service ID this preview was created from. */
  baseServiceId: string;
  /** Preview service name. */
  name: string;
  /** Preview service slug. */
  slug: string;
  /** Underlying Render service type inherited from the base service. */
  type: ServiceType;
  /** Workspace/owner ID. */
  ownerId: string;
  /** Public URL assigned to the preview instance, if applicable. */
  url?: string;
  /** Deployed container image path. */
  imagePath?: string;
  /** Active compute plan slug. */
  plan?: string;
  /** Deployment region inherited from the base service. */
  region?: string;
  /** Render Dashboard URL for this preview instance. */
  dashboardUrl: string;
  /** Suspension status (`"suspended"` or `"not_suspended"`). */
  suspended: string;
  /** Redacted environment variables active on the preview instance. */
  envVars: Record<string, Redacted.Redacted<string>>;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface ServicePreviewLookup {
  /** Look up an existing preview service by service ID (`srv-...`). */
  id?: string;
  /** Look up an existing preview service by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * Spawns an ephemeral image-backed preview instance (`POST /v1/services/{id}/preview`)
 * cloning configuration from a base image-backed Render service while overriding
 * the container image tag/digest, plan, or environment variables.
 *
 * **Example:** Pull request preview service for an image-backed web API
 * ```typescript
 * const preview = yield* Render.ServicePreview("PrPreview", {
 *   baseServiceId: api.id,
 *   imagePath: "ghcr.io/org/api:pr-42",
 *   plan: "starter",
 * });
 * ```
 *
 * @resource
 * @product Previews
 * @category Compute
 */
export interface ServicePreview extends Resource<
  "Render.ServicePreview",
  ServicePreviewProps,
  ServicePreviewAttributes,
  RenderServiceBinding,
  Providers,
  ServicePreviewLookup
> {}

export const ServicePreview = Resource<ServicePreview>("Render.ServicePreview");

const mapServicePreview = (
  data: HydratedServiceData,
  baseServiceId: string,
): ServicePreviewAttributes => {
  const s = data.service;
  const d = s.serviceDetails;
  const envVars: Record<string, Redacted.Redacted<string>> = {};
  for (const ev of data.envVars) {
    envVars[ev.key] = toRedacted(ev.value);
  }
  return {
    id: s.id,
    baseServiceId,
    name: s.name,
    slug: s.slug,
    type: s.type,
    ownerId: s.ownerId,
    url: d.url,
    imagePath: s.imagePath,
    plan: d.plan,
    region: d.region,
    dashboardUrl: s.dashboardUrl,
    suspended: s.suspended,
    envVars,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
};

export const ServicePreviewProvider = () =>
  Provider.effect(
    ServicePreview,
    Effect.succeed({
      stables: ["id", "slug", "baseServiceId", "type"],
      nuke: {
        dependsOn: [
          "Render.WebService",
          "Render.PrivateService",
          "Render.BackgroundWorker",
          "Render.CronJob",
        ],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (olds.baseServiceId !== news.baseServiceId) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        const baseServiceId =
          output?.baseServiceId ??
          (typeof olds?.baseServiceId === "string" ? olds.baseServiceId : "");
        if (output?.id) {
          const svc = yield* Client.ignoreNotFound(Client.getService(output.id));
          return svc ? mapServicePreview(yield* hydrateService(svc), baseServiceId) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const list = yield* Client.listServices({ ownerId: [ownerId], name: [desiredName] });
        const matched = list.find((s) => s.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapServicePreview(yield* hydrateService(matched), baseServiceId);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const svc = yield* Client.ignoreNotFound(Client.getService(props.id));
          return svc ? mapServicePreview(yield* hydrateService(svc), "") : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const list = yield* Client.listServices({ ownerId: [ownerId], name: [props.name] });
          const matched = list.find((s) => s.name === props.name);
          return matched ? mapServicePreview(yield* hydrateService(matched), "") : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        // Preview services are enumerated under their underlying ServiceType resources.
        return [];
      }),
      reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getService(output.id))
          : undefined;
        const mergedEnv = mergeBoundEnvVars(
          news.envVars,
          bindings.map((b) => b.data),
        );

        let serviceId: string;
        if (!existing) {
          const created = yield* Client.createServicePreview(news.baseServiceId, {
            imagePath: news.imagePath,
            name: desiredName,
            ...(news.plan !== undefined ? { plan: news.plan } : {}),
          });
          const service = created.service
            ? created.service
            : yield* Client.listServices({ name: [desiredName] }).pipe(
                Effect.map((rows) => rows[0]),
              );
          if (!service) {
            return yield* new RenderNotFoundError({
              status: 404,
              method: "POST",
              path: `/services/${encodeURIComponent(news.baseServiceId)}/preview`,
              message: `Render preview service "${desiredName}" was not returned after creation.`,
            });
          }
          serviceId = service.id;
          if (Object.keys(mergedEnv).length > 0) {
            yield* Client.putServiceEnvVars(serviceId, envVarsToWire(mergedEnv, [], false));
          }
        } else {
          serviceId = existing.id;
          const hydratedBefore = yield* hydrateService(existing);
          yield* Client.updateService(serviceId, {
            name: desiredName,
            image: { ownerId: existing.ownerId, imagePath: news.imagePath },
            ...(news.plan !== undefined ? { serviceDetails: { plan: news.plan } } : {}),
          });
          if (
            news.envVars !== undefined ||
            bindings.length > 0 ||
            hydratedBefore.envVars.length > 0
          ) {
            yield* Client.putServiceEnvVars(
              serviceId,
              envVarsToWire(mergedEnv, hydratedBefore.envVars, true),
            );
          }
        }

        if (news.waitForDeployCompletion) {
          yield* waitForServiceLive("Render.ServicePreview", serviceId);
        }

        const fresh = yield* Client.getService(serviceId);
        return mapServicePreview(yield* hydrateService(fresh), news.baseServiceId);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteService(output.id);
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
    }),
  );
