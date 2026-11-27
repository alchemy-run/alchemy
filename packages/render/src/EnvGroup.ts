import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Api from "./internal/Api.ts";
import { toRedacted, unwrapSecret } from "./internal/Redacted.ts";
import { envVarsToWire, secretFilesToWire } from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { EnvVarValueSpec, SecretFileOutput, SecretString } from "./Types.ts";

export interface EnvGroupProps {
  /** Environment group name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Optional Render project environment ID (`env-...`) to scope the environment group to. */
  environmentId?: string;
  /** Key/value environment variables or generated secrets in the group. */
  envVars?: Record<string, EnvVarValueSpec>;
  /** Secret files mounted at `/etc/secrets/<name>` on linked services. */
  secretFiles?: Record<string, SecretString>;
}

export interface EnvGroupAttributes {
  /** Environment group ID (`evg-...`). */
  id: string;
  /** Environment group name. */
  name: string;
  /** Workspace/owner ID owning the group. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Redacted map of environment variables in the group. */
  envVars: Record<string, Redacted.Redacted<string>>;
  /** Redacted list of secret files in the group. */
  secretFiles: SecretFileOutput[];
  /** Service IDs currently linked to this environment group. */
  serviceIds: string[];
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface EnvGroupLookup {
  /** Look up an environment group by ID. */
  id?: string;
  /** Look up an environment group by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * Shared environment variables and secret files that can be linked across
 * multiple Render services via {@link EnvGroupLink}.
 *
 * **Example:** Shared environment group
 * ```typescript
 * const shared = yield* Render.EnvGroup("SharedConfig", {
 *   name: "app-shared",
 *   environmentId: env.id,
 *   envVars: {
 *     LOG_LEVEL: "info",
 *     JWT_SECRET: { generateValue: true },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Env Groups
 * @category Config & Access
 */
export interface EnvGroup extends Resource<
  "Render.EnvGroup",
  EnvGroupProps,
  EnvGroupAttributes,
  never,
  Providers,
  EnvGroupLookup
> {}

export const EnvGroup = Resource<EnvGroup>("Render.EnvGroup");

const mapEnvGroup = (group: RenderSdk.CreateEnvGroupResponse): EnvGroupAttributes => {
  const envVars: Record<string, Redacted.Redacted<string>> = {};
  for (const ev of group.envVars ?? []) {
    envVars[ev.key] = toRedacted(ev.value);
  }
  return {
    id: group.id,
    name: group.name,
    ownerId: group.ownerId,
    environmentId: group.environmentId,
    envVars,
    secretFiles: (group.secretFiles ?? []).map((f) => ({
      name: f.name,
      content: toRedacted(f.content),
    })),
    serviceIds: group.serviceLinks.map((s) => s.id),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
};

export const EnvGroupProvider = () =>
  Provider.effect(
    EnvGroup,
    Effect.succeed({
      stables: ["id"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project"],
      },
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const group = yield* Api.ignoreNotFound(RenderSdk.getEnvGroup({ envGroupId: output.id }));
          return group ? mapEnvGroup(group) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const list = yield* RenderSdk.listEnvGroups({ ownerId: [ownerId], limit: 100 });
        const matched = list.find((g) => g.name === desiredName);
        if (!matched) return undefined;
        const full = yield* Api.ignoreNotFound(RenderSdk.getEnvGroup({ envGroupId: matched.id }));
        if (!full) return undefined;
        const attrs = mapEnvGroup(full);
        return explicitName === undefined || full.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const group = yield* Api.ignoreNotFound(RenderSdk.getEnvGroup({ envGroupId: props.id }));
          return group ? mapEnvGroup(group) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const list = yield* RenderSdk.listEnvGroups({ ownerId: [ownerId], limit: 100 });
          const matched = list.find((g) => g.name === props.name);
          if (!matched) return undefined;
          const full = yield* Api.ignoreNotFound(RenderSdk.getEnvGroup({ envGroupId: matched.id }));
          return full ? mapEnvGroup(full) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const metas = yield* RenderSdk.listEnvGroups({ ownerId: [ownerId], limit: 100 });
        return yield* Effect.forEach(metas, (meta) =>
          RenderSdk.getEnvGroup({ envGroupId: meta.id }),
        ).pipe(Effect.map((groups) => groups.map(mapEnvGroup)));
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const desiredEnvVars = news.envVars ?? {};
        const desiredSecretFiles = news.secretFiles ?? {};

        const existing = output?.id
          ? yield* Api.ignoreNotFound(RenderSdk.getEnvGroup({ envGroupId: output.id }))
          : undefined;

        if (!existing) {
          const ownerId = yield* Api.resolveOwnerId(news.ownerId);
          const wireVars = envVarsToWire(desiredEnvVars, [], false);
          const wireFiles = secretFilesToWire(desiredSecretFiles);
          const created = yield* RenderSdk.createEnvGroup({
            name,
            ownerId,
            ...(news.environmentId !== undefined ? { environmentId: news.environmentId } : {}),
            envVars: wireVars,
            ...(wireFiles.length > 0 ? { secretFiles: wireFiles } : {}),
          });
          return mapEnvGroup(created);
        }

        const existingVars = existing.envVars ?? [];
        const existingVarMap = new Map<string, RenderSdk.EnvVar>(
          existingVars.map((v) => [v.key, v]),
        );

        for (const [key, spec] of Object.entries(desiredEnvVars)) {
          const existingVar = existingVarMap.get(key);
          if (typeof spec === "object" && spec !== null && "generateValue" in spec) {
            if (spec.generateValue && !existingVar) {
              yield* RenderSdk.updateEnvGroupEnvVar({
                envGroupId: existing.id,
                envVarKey: key,
                body: { generateValue: true },
              });
            }
            continue;
          }
          const rawValue = unwrapSecret(
            typeof spec === "object" && spec !== null && "value" in spec ? spec.value : spec,
          );
          if (!existingVar || existingVar.value !== rawValue) {
            yield* RenderSdk.updateEnvGroupEnvVar({
              envGroupId: existing.id,
              envVarKey: key,
              body: { value: rawValue },
            });
          }
        }
        for (const ev of existingVars) {
          if (!(ev.key in desiredEnvVars)) {
            yield* RenderSdk.deleteEnvGroupEnvVar({
              envGroupId: existing.id,
              envVarKey: ev.key,
            });
          }
        }

        const existingFiles = existing.secretFiles ?? [];
        const existingFileMap = new Map(existingFiles.map((f) => [f.name, f.content]));
        for (const [fileName, content] of Object.entries(desiredSecretFiles)) {
          const raw = unwrapSecret(content);
          if (existingFileMap.get(fileName) !== raw) {
            yield* RenderSdk.updateEnvGroupSecretFile({
              envGroupId: existing.id,
              envVarKey: fileName,
              content: raw,
            });
          }
        }
        for (const sf of existingFiles) {
          if (!(sf.name in desiredSecretFiles)) {
            yield* RenderSdk.deleteEnvGroupSecretFile({
              envGroupId: existing.id,
              envVarKey: sf.name,
            });
          }
        }

        yield* Api.syncResourceEnvironment(existing.id, existing.environmentId, news.environmentId);

        const updated =
          existing.name !== name
            ? yield* RenderSdk.updateEnvGroup({ envGroupId: existing.id, name })
            : yield* RenderSdk.getEnvGroup({ envGroupId: existing.id });
        return mapEnvGroup(updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(RenderSdk.deleteEnvGroup({ envGroupId: output.id }));
      }),
    }),
  );
