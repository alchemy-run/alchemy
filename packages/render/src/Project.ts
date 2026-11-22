import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Client from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";
import type { CidrBlockAndDescription, ProtectedStatus } from "./Types.ts";

export interface ProjectEnvironmentConfig {
  /** Environment name within the project. */
  name: string;
  /** Protection status (`"protected"` or `"unprotected"`). */
  protectedStatus?: ProtectedStatus;
  /** Whether services in this environment are network-isolated from other environments. */
  networkIsolated?: boolean;
  /** CIDR blocks allowed to reach services in this environment. */
  ipAllowList?: CidrBlockAndDescription[];
}

export interface ProjectEnvironmentAttributes {
  /** Render environment ID (`env-...`). */
  id: string;
  /** Environment name. */
  name: string;
  /** Protection status (`"protected"` or `"unprotected"`). */
  protectedStatus: ProtectedStatus;
  /** Whether cross-environment network isolation is enabled. */
  networkIsolated: boolean;
  /** IP allow list rules on the environment. */
  ipAllowList?: CidrBlockAndDescription[];
}

export interface ProjectProps {
  /** Project name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /**
   * Keyed map of environments to manage inline inside the project (for example
   * `{ production: { name: "production", protectedStatus: "unprotected" } }`).
   * Defaults to a single `production` environment when omitted.
   */
  environments?: Record<string, ProjectEnvironmentConfig>;
}

export interface ProjectAttributes {
  /** Render project ID (`prj-...`). */
  id: string;
  /** Project name. */
  name: string;
  /** Owner workspace/user ID. */
  ownerId: string;
  /** Map of logical environment key to reconciled environment attributes. */
  environments: Record<string, ProjectEnvironmentAttributes>;
  /** All Render environment IDs currently belonging to this project. */
  environmentIds: string[];
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface ProjectLookup {
  /** Look up an existing Render project by ID. */
  id?: string;
  /** Look up an existing Render project by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render project groups environments (such as `staging` and `production`)
 * and isolates configuration across services and datastores.
 *
 * **Example:** Project with production and staging environments
 * ```typescript
 * const app = yield* Render.Project("App", {
 *   name: "my-app",
 *   environments: {
 *     production: { name: "production", protectedStatus: "protected", networkIsolated: true },
 *     staging: { name: "staging", protectedStatus: "unprotected" },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Organization
 * @category Organization
 */
export interface Project extends Resource<
  "Render.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers,
  ProjectLookup
> {}

export const Project = Resource<Project>("Render.Project");

const DEFAULT_ENVIRONMENTS: Record<string, ProjectEnvironmentConfig> = {
  production: {
    name: "production",
    protectedStatus: "unprotected",
    networkIsolated: false,
  },
};

const hydrateProject = (
  proj: {
    id: string;
    name: string;
    owner: { id: string };
    environmentIds: string[];
    createdAt: string;
    updatedAt: string;
  },
  keyHintById?: Map<string, string>,
  desiredByKey?: Record<string, ProjectEnvironmentConfig>,
): Effect.Effect<
  ProjectAttributes,
  Effect.Error<ReturnType<typeof Client.getEnvironment>>,
  Effect.Services<ReturnType<typeof Client.getEnvironment>>
> =>
  Effect.gen(function* () {
    const environments: Record<string, ProjectEnvironmentAttributes> = {};
    for (const envId of proj.environmentIds) {
      const env = yield* Client.ignoreNotFound(Client.getEnvironment(envId));
      if (!env) continue;
      let key = keyHintById?.get(env.id);
      if (!key && desiredByKey) {
        key = Object.entries(desiredByKey).find(([, cfg]) => cfg.name === env.name)?.[0];
      }
      if (!key) {
        key = env.name;
      }
      environments[key] = {
        id: env.id,
        name: env.name,
        protectedStatus: env.protectedStatus,
        networkIsolated: env.networkIsolationEnabled,
        ipAllowList: env.ipAllowList,
      };
    }
    return {
      id: proj.id,
      name: proj.name,
      ownerId: proj.owner.id,
      environments,
      environmentIds: proj.environmentIds,
      createdAt: proj.createdAt,
      updatedAt: proj.updatedAt,
    };
  });

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.succeed({
      stables: ["id"],
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const proj = yield* Client.ignoreNotFound(Client.getProject(output.id));
          if (!proj) return undefined;
          const keyHint = new Map<string, string>();
          for (const [key, val] of Object.entries(output.environments ?? {})) {
            keyHint.set(val.id, key);
          }
          return yield* hydrateProject(proj, keyHint);
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const all = yield* Client.listProjects({ ownerId: [ownerId] });
        const matched = all.find((p) => p.name === desiredName);
        if (!matched) return undefined;
        const attrs = yield* hydrateProject(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const proj = yield* Client.ignoreNotFound(Client.getProject(props.id));
          return proj ? yield* hydrateProject(proj) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const all = yield* Client.listProjects({ ownerId: [ownerId] });
          const matched = all.find((p) => p.name === props.name);
          return matched ? yield* hydrateProject(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const all = yield* Client.listProjects({ ownerId: [ownerId] });
        return yield* Effect.forEach(all, (proj) => hydrateProject(proj));
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const desiredEnvs = news.environments ?? DEFAULT_ENVIRONMENTS;

        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getProject(output.id))
          : undefined;

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const created = yield* Client.createProject({
            name: desiredName,
            ownerId,
            environments: Object.values(desiredEnvs).map((env) => ({
              name: env.name,
              protectedStatus: env.protectedStatus ?? "unprotected",
              networkIsolationEnabled: env.networkIsolated ?? false,
              ...(env.ipAllowList !== undefined ? { ipAllowList: env.ipAllowList } : {}),
            })),
          });
          return yield* hydrateProject(created, undefined, desiredEnvs);
        }

        const updatedProj =
          existing.name !== desiredName
            ? yield* Client.updateProject(existing.id, { name: desiredName })
            : existing;

        const currentByKey = output?.environments ?? {};
        const keyHint = new Map<string, string>();
        const keptEnvIds = new Set<string>();

        for (const [key, desiredEnv] of Object.entries(desiredEnvs)) {
          const prev =
            currentByKey[key] ??
            Object.values(currentByKey).find((e) => e.name === desiredEnv.name);
          if (prev?.id && existing.environmentIds.includes(prev.id)) {
            keptEnvIds.add(prev.id);
            keyHint.set(prev.id, key);
            yield* Client.updateEnvironment(prev.id, {
              name: desiredEnv.name,
              protectedStatus: desiredEnv.protectedStatus ?? "unprotected",
              networkIsolationEnabled: desiredEnv.networkIsolated ?? false,
              ...(desiredEnv.ipAllowList !== undefined
                ? { ipAllowList: desiredEnv.ipAllowList }
                : prev.ipAllowList !== undefined
                  ? { ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "everywhere" }] }
                  : {}),
            });
          } else {
            const createdEnv = yield* Client.createEnvironment({
              projectId: existing.id,
              name: desiredEnv.name,
              protectedStatus: desiredEnv.protectedStatus ?? "unprotected",
              networkIsolationEnabled: desiredEnv.networkIsolated ?? false,
              ...(desiredEnv.ipAllowList !== undefined
                ? { ipAllowList: desiredEnv.ipAllowList }
                : {}),
            });
            keptEnvIds.add(createdEnv.id);
            keyHint.set(createdEnv.id, key);
          }
        }

        for (const oldEnv of Object.values(currentByKey)) {
          if (!keptEnvIds.has(oldEnv.id)) {
            yield* Client.deleteEnvironment(oldEnv.id);
          }
        }

        const refreshed = yield* Client.getProject(updatedProj.id);
        return yield* hydrateProject(refreshed, keyHint, desiredEnvs);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteProject(output.id);
      }),
    }),
  );
