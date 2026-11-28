import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Api from "./internal/Api.ts";
import type { Providers } from "./Providers.ts";
import type { CidrBlockAndDescription, ProtectedStatus } from "./Types.ts";

export interface EnvironmentProps {
  /** Render project ID (`prj-...`) that owns this environment. Changing it replaces the environment. */
  projectId: string;
  /** Environment name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Protection status (`"protected"` or `"unprotected"`). */
  protectedStatus?: ProtectedStatus;
  /** Whether services in this environment are network-isolated from other environments. */
  networkIsolated?: boolean;
  /** CIDR blocks permitted to reach services in this environment. */
  ipAllowList?: CidrBlockAndDescription[];
}

export interface EnvironmentAttributes {
  /** Render environment ID (`env-...`). */
  id: string;
  /** Owning project ID. */
  projectId: string;
  /** Environment name. */
  name: string;
  /** Protection status (`"protected"` or `"unprotected"`). */
  protectedStatus: ProtectedStatus;
  /** Whether network isolation is enabled. */
  networkIsolated: boolean;
  /** IP allow list configured on the environment. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Attached service IDs. */
  serviceIds: string[];
  /** Attached Postgres database IDs. */
  databasesIds: string[];
  /** Attached Key Value IDs. */
  redisIds: string[];
  /** Attached environment group IDs. */
  envGroupIds: string[];
}

export interface EnvironmentLookup {
  /** Look up an environment by ID. */
  id?: string;
  /** Look up an environment by project ID + name. */
  projectId?: string;
  /** Environment name when looking up under `projectId`. */
  name?: string;
}

/**
 * A Render project environment isolating services, datastores, environment
 * groups, and network policies under a {@link Project}.
 *
 * **Example:** Standalone staging environment
 * ```typescript
 * const staging = yield* Render.Environment("Staging", {
 *   projectId: app.id,
 *   name: "staging",
 *   protectedStatus: "unprotected",
 *   networkIsolated: true,
 * });
 * ```
 *
 * @resource
 * @product Organization
 * @category Organization
 */
export interface Environment extends Resource<
  "Render.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers,
  EnvironmentLookup
> {}

export const Environment = Resource<Environment>("Render.Environment");

const mapEnvironment = (env: RenderSdk.Environment): EnvironmentAttributes => ({
  id: env.id,
  projectId: env.projectId,
  name: env.name,
  protectedStatus: env.protectedStatus,
  networkIsolated: env.networkIsolationEnabled,
  ipAllowList: env.ipAllowList,
  serviceIds: env.serviceIds ?? [],
  databasesIds: env.databasesIds ?? [],
  redisIds: env.redisIds ?? [],
  envGroupIds: env.envGroupIds ?? [],
});

const listEnvironmentsByProjectIds = (projectId: string[]) =>
  Api.paginateCursorList(
    (cursor) => RenderSdk.listEnvironments({ projectId, cursor, limit: 100 }),
    (row) => row.environment,
  );

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.succeed({
      stables: ["id"],
      nuke: {
        dependsOn: ["Render.Project"],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (olds.projectId !== news.projectId) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const env = yield* Api.ignoreNotFound(
            RenderSdk.getEnvironment({ environmentId: output.id }),
          );
          return env ? mapEnvironment(env) : undefined;
        }
        const projectId =
          typeof olds?.projectId === "string" && olds.projectId.length > 0
            ? olds.projectId
            : undefined;
        if (!projectId) return undefined;
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const all = yield* listEnvironmentsByProjectIds([projectId]);
        const matched = all.find((e) => e.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapEnvironment(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const env = yield* Api.ignoreNotFound(
            RenderSdk.getEnvironment({ environmentId: props.id }),
          );
          return env ? mapEnvironment(env) : undefined;
        }
        if (props.projectId && props.name) {
          const all = yield* listEnvironmentsByProjectIds([props.projectId]);
          const matched = all.find((e) => e.name === props.name);
          return matched ? mapEnvironment(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const projects = yield* Api.paginateCursorList(
          (cursor) => RenderSdk.listProjects({ ownerId: [ownerId], cursor, limit: 100 }),
          (row) => row.project,
        );
        if (projects.length === 0) return [];
        const all = yield* listEnvironmentsByProjectIds(projects.map((p) => p.id));
        return all.map(mapEnvironment);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output }) {
        const name = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Api.ignoreNotFound(RenderSdk.getEnvironment({ environmentId: output.id }))
          : undefined;

        if (!existing) {
          const created = yield* RenderSdk.createEnvironment({
            projectId: news.projectId,
            name,
            protectedStatus: news.protectedStatus ?? "unprotected",
            networkIsolationEnabled: news.networkIsolated ?? false,
            ...(news.ipAllowList !== undefined ? { ipAllowList: news.ipAllowList } : {}),
          });
          return mapEnvironment(created);
        }

        const updated = yield* RenderSdk.updateEnvironment({
          environmentId: existing.id,
          name,
          protectedStatus: news.protectedStatus ?? "unprotected",
          networkIsolationEnabled: news.networkIsolated ?? false,
          ...(news.ipAllowList !== undefined
            ? { ipAllowList: news.ipAllowList }
            : olds?.ipAllowList !== undefined
              ? { ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "everywhere" }] }
              : {}),
        });
        return mapEnvironment(updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(RenderSdk.deleteEnvironment({ environmentId: output.id }));
      }),
    }),
  );
