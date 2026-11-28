import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RenderValidationError } from "./Errors.ts";
import * as Api from "./internal/Api.ts";
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
  /** Sync state (for example `"success"`, `"running"`, `"error"`). */
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

const listAllBlueprints = (ownerId: string) =>
  Api.paginateCursorList(
    (cursor) => RenderSdk.listBlueprints({ ownerId: [ownerId], cursor, limit: 100 }),
    (row) => row.blueprint,
  );

const mapBlueprint = (
  detail: RenderSdk.GetBlueprintResponse,
  syncs: ReadonlyArray<RenderSdk.SyncWithCursorSync>,
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
  resources: detail.resources.map((r) => ({ id: r.id, name: r.name, type: r.type })),
  recentSyncs: syncs.map((s) => ({
    id: s.id,
    state: s.state,
    commitId: s.commit.id,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  })),
});

const hydrateBlueprint = (blueprintId: string) =>
  Effect.gen(function* () {
    const detail = yield* RenderSdk.getBlueprint({ blueprintId });
    const syncs =
      (yield* Api.ignoreNotFound(
        Api.paginateCursorList(
          (cursor) => RenderSdk.listBlueprintSyncs({ blueprintId, cursor, limit: 100 }),
          (row) => row.sync,
        ),
      )) ?? [];
    return mapBlueprint(detail, syncs);
  });

const formatValidationErrors = (validation: RenderSdk.ValidateBlueprintResponse): string =>
  validation.errors?.map((e) => (e.path ? `${e.path}: ${e.error}` : e.error)).join("; ") ||
  "Blueprint YAML validation failed.";

/**
 * `@distilled.cloud/render` `156659ace` types `ValidateBlueprintRequest.file` as
 * `string` while its HTTP trait uses `contentType: "multipart"`, where
 * `protocol-http.ts` appends binary parts only for `Blob | Uint8Array | ArrayBuffer`.
 */
const blueprintYamlFile = (yaml: string): string =>
  new File([yaml], "render.yaml", { type: "application/x-yaml" }) as unknown as string;

/** Validate a `render.yaml` Blueprint document against Render's `/v1/blueprints/validate` endpoint. */
export const validateBlueprint = (options: { readonly ownerId?: string; readonly yaml: string }) =>
  Effect.gen(function* () {
    const ownerId = yield* Api.resolveOwnerId(options.ownerId);
    return yield* RenderSdk.validateBlueprint({ ownerId, file: blueprintYamlFile(options.yaml) });
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
    const ownerId = yield* Api.resolveOwnerId(news.ownerId);
    const all = yield* listAllBlueprints(ownerId);
    const matched = all.find((b) => b.name === news.name);
    if (!matched) {
      return yield* new RenderSdk.NotFound({
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
          const detail = yield* Api.ignoreNotFound(
            RenderSdk.getBlueprint({ blueprintId: output.id }),
          );
          return detail ? yield* hydrateBlueprint(detail.id) : undefined;
        }
        const explicitId =
          typeof olds?.blueprintId === "string" && olds.blueprintId.length > 0
            ? olds.blueprintId
            : undefined;
        if (explicitId) {
          const detail = yield* Api.ignoreNotFound(
            RenderSdk.getBlueprint({ blueprintId: explicitId }),
          );
          if (!detail) return undefined;
          const attrs = yield* hydrateBlueprint(detail.id);
          return detail.id === previous?.id ? attrs : Unowned(attrs);
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        if (!explicitName) return undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const all = yield* listAllBlueprints(ownerId);
        const matched = all.find((b) => b.name === explicitName);
        if (!matched) return undefined;
        const attrs = yield* hydrateBlueprint(matched.id);
        return matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const detail = yield* Api.ignoreNotFound(
            RenderSdk.getBlueprint({ blueprintId: props.id }),
          );
          return detail ? yield* hydrateBlueprint(detail.id) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const all = yield* listAllBlueprints(ownerId);
          const matched = all.find((b) => b.name === props.name);
          return matched ? yield* hydrateBlueprint(matched.id) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const all = yield* listAllBlueprints(ownerId);
        return yield* Effect.forEach(all, (b) => hydrateBlueprint(b.id));
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const targetId = yield* resolveBlueprintTargetId(output?.id ?? news.blueprintId, news);

        const current = yield* RenderSdk.getBlueprint({ blueprintId: targetId });

        if (news.validateYaml !== undefined) {
          const validation = yield* RenderSdk.validateBlueprint({
            ownerId: current.ownerId,
            file: blueprintYamlFile(news.validateYaml),
          });
          if (validation.valid === false) {
            return yield* new RenderValidationError({
              field: "validateYaml",
              message: formatValidationErrors(validation),
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
          yield* RenderSdk.updateBlueprint({ blueprintId: current.id, ...patch });
        }

        return yield* hydrateBlueprint(current.id);
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        if (!output?.id || olds?.disconnectOnDelete !== true) {
          return;
        }
        yield* Api.deleteIdempotent(RenderSdk.disconnectBlueprint({ blueprintId: output.id }));
      }),
    }),
  );
