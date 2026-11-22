import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RenderNotFoundError, RenderValidationError } from "./Errors.ts";
import * as Client from "./internal/Client.ts";
import type { WireBlueprintDetail, WireBlueprintSync } from "./internal/WireTypes.ts";
import type { Providers } from "./Providers.ts";
import type { BlueprintStatus } from "./Types.ts";

export interface BlueprintResourceSummary {
  /** Managed resource ID on Render. */
  readonly id: string;
  /** Resource name. */
  readonly name: string;
  /** Resource type reported by Render. */
  readonly type: string;
}

export interface BlueprintSyncSummary {
  /** Blueprint sync ID (`syc-...`). */
  readonly id: string;
  /** Sync state (for example `"succeeded"`, `"running"`, `"failed"`). */
  readonly state: string;
  /** Commit SHA associated with the sync, if present. */
  readonly commitId?: string;
  /** Sync start timestamp (ISO 8601). */
  readonly startedAt?: string;
  /** Sync completion timestamp (ISO 8601). */
  readonly completedAt?: string;
}

export interface BlueprintProps {
  /** Existing Render Blueprint ID (`exs-...`) to manage or adopt. */
  blueprintId?: string;
  /** Blueprint name (also used to locate an existing Blueprint when `blueprintId` is omitted, or to rename it). */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or sole owner on `/owners`. */
  ownerId?: string;
  /** Toggle automatic sync on Git pushes to the configured branch. */
  autoSync?: boolean;
  /** Git branch holding the Blueprint specification (`render.yaml`). */
  branch?: string;
  /** Repository-relative path to `render.yaml`. */
  path?: string;
  /** Optional `render.yaml` contents validated against `POST /v1/blueprints/validate` during reconcile. */
  validateYaml?: string;
  /**
   * When `true`, destroying this Alchemy resource calls `DELETE /v1/blueprints/{id}`
   * (disconnecting the Blueprint in Render without deleting managed resources).
   * Defaults to `false`.
   */
  disconnectOnDelete?: boolean;
}

export interface BlueprintAttributes {
  /** Render Blueprint ID (`exs-...`). */
  id: string;
  /** Blueprint name. */
  name: string;
  /** Owner workspace ID. */
  ownerId: string;
  /** Linked Git repository URL. */
  repo: string;
  /** Branch watched for `render.yaml` changes. */
  branch: string;
  /** File path to `render.yaml`. */
  path: string;
  /** Blueprint lifecycle status (`"synced"`, `"paused"`, `"syncing"`, `"error"`, ...). */
  status: BlueprintStatus;
  /** Whether automatic Git sync is enabled. */
  autoSync: boolean;
  /** Timestamp of the most recent sync, if any. */
  lastSync?: string;
  /** Resources managed by this Blueprint on Render. */
  resources: BlueprintResourceSummary[];
  /** Recent Blueprint sync history entries. */
  recentSyncs: BlueprintSyncSummary[];
}

export interface BlueprintLookup {
  /** Look up a Render Blueprint by ID (`exs-...`). */
  id?: string;
  /** Look up a Render Blueprint by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * Manages a Render Blueprint (`render.yaml` IaC sync) configuration — updating
 * `autoSync`, `branch`, `path`, and `name`, validating Blueprint YAML manifests
 * via `POST /v1/blueprints/validate`, and inspecting managed resources and sync
 * history.
 *
 * Render Blueprints are connected via Git in the Render Dashboard rather than a
 * creation REST endpoint, so specify `blueprintId` or the existing Blueprint's
 * `name`.
 *
 * **Example:** Manage and validate a Blueprint
 * ```typescript
 * const bp = yield* Render.Blueprint("InfraBlueprint", {
 *   blueprintId: "exs-1234567890",
 *   autoSync: true,
 *   branch: "main",
 *   path: "render.yaml",
 * });
 * ```
 *
 * @resource
 * @product Blueprints
 * @category Organization
 */
export interface Blueprint extends Resource<
  "Render.Blueprint",
  BlueprintProps,
  BlueprintAttributes,
  never,
  Providers,
  BlueprintLookup
> {}

export const Blueprint = Resource<Blueprint>("Render.Blueprint");

const mapBlueprint = (
  detail: WireBlueprintDetail,
  syncs: ReadonlyArray<WireBlueprintSync>,
): BlueprintAttributes => ({
  id: detail.id,
  name: detail.name,
  ownerId: detail.ownerId,
  repo: detail.repo,
  branch: detail.branch,
  path: detail.path,
  status: detail.status,
  autoSync: detail.autoSync,
  lastSync: detail.lastSync,
  resources: (detail.resources ?? []).map((r) => ({ id: r.id, name: r.name, type: r.type })),
  recentSyncs: syncs.map((s) => ({
    id: s.id,
    state: s.state,
    commitId: s.commit?.id,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  })),
});

const hydrateBlueprint = (id: string) =>
  Effect.gen(function* () {
    const detail = yield* Client.getBlueprint(id);
    const syncs = yield* Client.listBlueprintSyncs(id).pipe(
      Effect.catchIf(
        (e) => e._tag === "RenderNotFoundError" || e._tag === "RenderForbiddenError",
        () => Effect.succeed([] as WireBlueprintSync[]),
      ),
    );
    return mapBlueprint(detail, syncs);
  });

/** Validate a `render.yaml` Blueprint document against Render's `/v1/blueprints/validate` endpoint. */
export const validateBlueprint = (options: {
  readonly ownerId?: string;
  readonly yaml: string;
  readonly filename?: string;
}) =>
  Effect.gen(function* () {
    const ownerId = yield* Client.resolveOwnerId(options.ownerId);
    return yield* Client.validateBlueprint(ownerId, options.yaml, options.filename);
  });

const resolveBlueprintTargetId = (resolvedId: string | undefined, news: BlueprintProps) =>
  Effect.gen(function* () {
    if (resolvedId !== undefined) {
      return resolvedId;
    }
    if (!news.name) {
      return yield* new RenderValidationError({
        field: "blueprintId",
        message:
          "Render Blueprint requires either blueprintId or the name of an existing connected Blueprint.",
      });
    }
    const ownerId = yield* Client.resolveOwnerId(news.ownerId);
    const all = yield* Client.listBlueprints({ ownerId: [ownerId] });
    const matched = all.find((b) => b.name === news.name);
    if (!matched) {
      return yield* new RenderNotFoundError({
        status: 404,
        method: "GET",
        path: "/blueprints",
        message: `Blueprint "${news.name}" not found on Render owner ${ownerId}.`,
      });
    }
    return matched.id;
  });

export const BlueprintProvider = () =>
  Provider.effect(
    Blueprint,
    Effect.succeed({
      stables: ["id", "ownerId", "repo"],
      nuke: { skip: true },
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        if (olds.blueprintId !== undefined && news.blueprintId !== olds.blueprintId) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output, previous }) {
        if (output?.id) {
          const detail = yield* Client.ignoreNotFound(Client.getBlueprint(output.id));
          return detail ? yield* hydrateBlueprint(detail.id) : undefined;
        }
        const explicitId =
          typeof olds?.blueprintId === "string" && olds.blueprintId.length > 0
            ? olds.blueprintId
            : undefined;
        if (explicitId) {
          const detail = yield* Client.ignoreNotFound(Client.getBlueprint(explicitId));
          if (!detail) return undefined;
          const attrs = yield* hydrateBlueprint(detail.id);
          return detail.id === previous?.id ? attrs : Unowned(attrs);
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        if (!explicitName) return undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const all = yield* Client.listBlueprints({ ownerId: [ownerId] });
        const matched = all.find((b) => b.name === explicitName);
        if (!matched) return undefined;
        const attrs = yield* hydrateBlueprint(matched.id);
        return matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const detail = yield* Client.ignoreNotFound(Client.getBlueprint(props.id));
          return detail ? yield* hydrateBlueprint(detail.id) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const all = yield* Client.listBlueprints({ ownerId: [ownerId] });
          const matched = all.find((b) => b.name === props.name);
          return matched ? yield* hydrateBlueprint(matched.id) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const all = yield* Client.listBlueprints({ ownerId: [ownerId] });
        return yield* Effect.forEach(all, (b) => hydrateBlueprint(b.id));
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const targetId = yield* resolveBlueprintTargetId(output?.id ?? news.blueprintId, news);

        const current = yield* Client.getBlueprint(targetId);

        if (news.validateYaml !== undefined) {
          const validation = yield* Client.validateBlueprint(current.ownerId, news.validateYaml);
          if (validation.valid === false) {
            return yield* new RenderValidationError({
              field: "validateYaml",
              message: validation.error ?? "Blueprint YAML validation failed.",
            });
          }
        }

        const patch: { name?: string; autoSync?: boolean; branch?: string; path?: string } = {};
        if (news.name !== undefined && news.name !== current.name) patch.name = news.name;
        if (news.autoSync !== undefined && news.autoSync !== current.autoSync) {
          patch.autoSync = news.autoSync;
        }
        if (news.branch !== undefined && news.branch !== current.branch) patch.branch = news.branch;
        if (news.path !== undefined && news.path !== current.path) patch.path = news.path;

        if (Object.keys(patch).length > 0) {
          yield* Client.updateBlueprint(current.id, patch);
        }

        return yield* hydrateBlueprint(current.id);
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        if (!output?.id || olds?.disconnectOnDelete !== true) {
          return;
        }
        yield* Client.deleteBlueprint(output.id);
      }),
    }),
  );
