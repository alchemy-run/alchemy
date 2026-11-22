import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Client from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export interface EnvGroupLinkProps {
  /** ID of the {@link EnvGroup} to link services to. Changing it replaces the link resource. */
  envGroupId: string;
  /** IDs of Render services (`srv-...`) to link to the environment group. */
  serviceIds: string[];
}

export interface EnvGroupLinkAttributes {
  /** Environment group ID (`evg-...`) used as the canonical link identifier. */
  envGroupId: string;
  /** Service IDs currently linked to the environment group. */
  serviceIds: string[];
}

export interface EnvGroupLinkLookup {
  /** Environment group ID whose service links should be fetched. */
  envGroupId: string;
}

/**
 * Links one or more Render services to an existing {@link EnvGroup} so those
 * services inherit the group's environment variables and secret files.
 *
 * **Example:** Attach an environment group to API and worker services
 * ```typescript
 * yield* Render.EnvGroupLink("SharedLinks", {
 *   envGroupId: shared.id,
 *   serviceIds: [api.id, worker.id],
 * });
 * ```
 *
 * @resource
 * @product Env Groups
 * @category Config & Access
 */
export interface EnvGroupLink extends Resource<
  "Render.EnvGroupLink",
  EnvGroupLinkProps,
  EnvGroupLinkAttributes,
  never,
  Providers,
  EnvGroupLinkLookup
> {}

export const EnvGroupLink = Resource<EnvGroupLink>("Render.EnvGroupLink");

export const EnvGroupLinkProvider = () =>
  Provider.effect(
    EnvGroupLink,
    Effect.succeed({
      stables: ["envGroupId"],
      nuke: {
        dependsOn: [
          "Render.EnvGroup",
          "Render.WebService",
          "Render.PrivateService",
          "Render.BackgroundWorker",
          "Render.CronJob",
          "Render.StaticSite",
        ],
      },
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        if (olds.envGroupId !== news.envGroupId) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        if (output?.envGroupId) {
          const group = yield* Client.ignoreNotFound(Client.getEnvGroup(output.envGroupId));
          if (!group) return undefined;
          return {
            envGroupId: group.id,
            serviceIds: group.serviceLinks.map((s) => s.id),
          };
        }
        const targetEnvGroupId =
          typeof olds?.envGroupId === "string" && olds.envGroupId.length > 0
            ? olds.envGroupId
            : undefined;
        if (!targetEnvGroupId) return undefined;
        const group = yield* Client.ignoreNotFound(Client.getEnvGroup(targetEnvGroupId));
        if (!group) return undefined;
        const expectedServiceIds = Array.isArray(olds?.serviceIds)
          ? olds.serviceIds.filter((s): s is string => typeof s === "string" && s.length > 0)
          : [];
        const linkedIds = group.serviceLinks.map((s) => s.id);
        if (
          expectedServiceIds.length === 0 ||
          !expectedServiceIds.some((sid) => linkedIds.includes(sid))
        ) {
          return undefined;
        }
        return {
          envGroupId: group.id,
          serviceIds: linkedIds,
        };
      }),
      lookup: Effect.fn(function* (props) {
        const group = yield* Client.ignoreNotFound(Client.getEnvGroup(props.envGroupId));
        if (!group) return undefined;
        return {
          envGroupId: group.id,
          serviceIds: group.serviceLinks.map((s) => s.id),
        };
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const metas = yield* Client.listEnvGroups({ ownerId: [ownerId] });
        return metas
          .filter((m) => m.serviceLinks.length > 0)
          .map((m) => ({
            envGroupId: m.id,
            serviceIds: m.serviceLinks.map((s) => s.id),
          }));
      }),
      reconcile: Effect.fn(function* ({ news }) {
        const group = yield* Client.getEnvGroup(news.envGroupId);
        const currentIds = new Set(group.serviceLinks.map((s) => s.id));
        const desiredIds = new Set(news.serviceIds);

        for (const serviceId of currentIds) {
          if (!desiredIds.has(serviceId)) {
            yield* Client.unlinkServiceFromEnvGroup(news.envGroupId, serviceId);
          }
        }
        for (const serviceId of desiredIds) {
          if (!currentIds.has(serviceId)) {
            yield* Client.linkServiceToEnvGroup(news.envGroupId, serviceId);
          }
        }

        const refreshed = yield* Client.getEnvGroup(news.envGroupId);
        return {
          envGroupId: refreshed.id,
          serviceIds: refreshed.serviceLinks.map((s) => s.id),
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.envGroupId) return;
        const group = yield* Client.ignoreNotFound(Client.getEnvGroup(output.envGroupId));
        if (!group) return;
        for (const link of group.serviceLinks) {
          if (output.serviceIds.includes(link.id)) {
            yield* Client.unlinkServiceFromEnvGroup(output.envGroupId, link.id);
          }
        }
      }),
    }),
  );
