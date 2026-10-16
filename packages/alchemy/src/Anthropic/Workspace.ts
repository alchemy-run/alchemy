import * as Anthropic from "@distilled.cloud/anthropic";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  stripInternalTags,
  tagRecord,
} from "../Tags.ts";
import type { Providers } from "./Providers.ts";

/**
 * Data residency for a Workspace.
 */
export interface WorkspaceDataResidency {
  /**
   * Geographic region where the Workspace's data is stored (e.g. `"us"`).
   * Immutable after creation — changing it replaces the Workspace.
   * @default "us"
   */
  workspaceGeo?: string;
  /**
   * Inference geos requests in this Workspace may run in: `"unrestricted"`
   * or a list of geos.
   * @default "unrestricted"
   */
  allowedInferenceGeos?: "unrestricted" | string[];
  /**
   * Inference geo applied when a request omits one. Must be a member of
   * `allowedInferenceGeos` unless that is `"unrestricted"`.
   * @default "global"
   */
  defaultInferenceGeo?: string;
}

export interface WorkspaceProps {
  /**
   * Name of the Workspace, shown in the Anthropic Console. If omitted, a
   * unique name is generated from the stack, stage and logical id.
   * Renaming is an in-place update.
   */
  name?: string;
  /**
   * Hex color code (e.g. `"#6C5BB9"`) representing the Workspace in the
   * Anthropic Console. Anthropic assigns one when omitted.
   */
  displayColor?: string;
  /**
   * Data residency configuration. Changing `workspaceGeo` replaces the
   * Workspace; the inference geos update in place.
   */
  dataResidency?: WorkspaceDataResidency;
  /**
   * ID of a customer-managed encryption key (CMEK) configuration. Requires
   * CMEK to be enabled for the organization. Write-once on Anthropic's side:
   * changing or removing it replaces the Workspace.
   */
  externalKeyId?: string;
  /**
   * User-defined tags. Keys may not begin with `anthropic`. Alchemy's
   * ownership tags (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) are
   * merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface WorkspaceAttributes {
  /** ID of the Workspace (`wrkspc_…`). */
  workspaceId: string;
  /** Name of the Workspace. */
  name: string;
  /** Hex color code representing the Workspace in the Console. */
  displayColor: string;
  /** Geographic region where Workspace data is stored. */
  workspaceGeo: string;
  /** Allowed inference geos: `"unrestricted"` or a list. */
  allowedInferenceGeos: "unrestricted" | string[];
  /** Default inference geo for requests that omit one. */
  defaultInferenceGeo: string;
  /** CMEK configuration ID, if any. */
  externalKeyId: string | null;
  /** Encryption compartment identifier (referenced by CMEK key policies). */
  compartmentId: string;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
  /** RFC 3339 creation timestamp. */
  createdAt: string;
}

export type Workspace = Resource<
  "Anthropic.Workspace",
  WorkspaceProps,
  WorkspaceAttributes,
  never,
  Providers
>;

/**
 * An Anthropic Workspace — an organization sub-division with its own API
 * keys, rate and spend limits, and data residency. Managed through the Admin
 * API, so it needs an Admin API key (`ANTHROPIC_ADMIN_KEY`).
 *
 * Anthropic has no delete for Workspaces: destroying this resource
 * **archives** the Workspace, which permanently disables it and its API keys.
 * Archived Workspaces stay visible (as archived) in the Console and cannot be
 * restored, so a replacement always creates a new Workspace.
 *
 * ### Creating a Workspace
 * **Example:** Generated name
 * ```typescript
 * const workspace = yield* Anthropic.Workspace("Agents", {});
 * ```
 *
 * **Example:** Named Workspace with tags
 * ```typescript
 * const workspace = yield* Anthropic.Workspace("Agents", {
 *   name: "agents-prod",
 *   displayColor: "#6C5BB9",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Data Residency
 * **Example:** Keep data in the US and pin inference to US geos
 * ```typescript
 * const workspace = yield* Anthropic.Workspace("Regulated", {
 *   dataResidency: {
 *     workspaceGeo: "us",
 *     allowedInferenceGeos: ["us"],
 *     defaultInferenceGeo: "us",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Anthropic
 * @category AI
 */
export const Workspace = Resource<Workspace>("Anthropic.Workspace");

type ObservedWorkspace = Anthropic.BetaWorkspace;

const toAllowedGeos = (value: unknown): "unrestricted" | string[] =>
  Array.isArray(value) ? value.map(String) : "unrestricted";

const toAttrs = (workspace: ObservedWorkspace): WorkspaceAttributes => ({
  workspaceId: workspace.id,
  name: workspace.name,
  displayColor: workspace.display_color,
  workspaceGeo: workspace.data_residency.workspace_geo,
  allowedInferenceGeos: toAllowedGeos(workspace.data_residency.allowed_inference_geos),
  defaultInferenceGeo: workspace.data_residency.default_inference_geo,
  externalKeyId: workspace.external_key_id,
  compartmentId: workspace.compartment_id,
  tags: stripInternalTags(tagRecord(workspace.tags)),
  createdAt: workspace.created_at,
});

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return name ?? existing ?? (yield* createPhysicalName({ id, maxLength: 40 }));
  });

/** An archived Workspace is gone as far as Alchemy is concerned. */
const live = (workspace: ObservedWorkspace | undefined) =>
  workspace !== undefined && workspace.archived_at === null ? workspace : undefined;

const getById = (workspaceId: string) =>
  Anthropic.getWorkspace({ workspace_id: workspaceId }).pipe(
    Effect.map(live),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Anthropic.listWorkspaces.items({ limit: 100 }).pipe(
    Stream.filter((workspace) => workspace.name === name && workspace.archived_at === null),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const observe = Effect.fn(function* (input: { workspaceId?: string; name: string }) {
  if (input.workspaceId !== undefined) {
    const byId = yield* getById(input.workspaceId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(input.name);
});

const sameGeos = (a: "unrestricted" | string[], b: "unrestricted" | string[]) =>
  a === "unrestricted" || b === "unrestricted"
    ? a === b
    : a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceId", "workspaceGeo", "compartmentId", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousGeo = olds?.dataResidency?.workspaceGeo ?? output?.workspaceGeo;
      const nextGeo = news.dataResidency?.workspaceGeo;
      if (nextGeo !== undefined && previousGeo !== undefined && nextGeo !== previousGeo) {
        return { action: "replace" } as const;
      }
      const previousKey = olds?.externalKeyId ?? output?.externalKeyId ?? undefined;
      if (previousKey !== undefined && news.externalKeyId !== previousKey) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* toName(id, olds?.name, output?.name);
      const existing = yield* observe({ workspaceId: output?.workspaceId, name });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyTags(id, tagRecord(existing.tags))) ? attrs : Unowned(attrs);
    }),

    // Only Workspaces carrying Alchemy's ownership tags — never the default
    // Workspace or ones created in the Console.
    list: () =>
      Anthropic.listWorkspaces.items({ limit: 100 }).pipe(
        Stream.filter(
          (workspace) =>
            workspace.archived_at === null &&
            tagRecord(workspace.tags)["alchemy::stack"] !== undefined,
        ),
        Stream.map(toAttrs),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* toName(id, news.name, output?.name);
      const desiredTags = { ...news.tags, ...(yield* createInternalTags(id)) };

      // Observe — by cached id, falling back to the deterministic name.
      let current = yield* observe({ workspaceId: output?.workspaceId, name });

      // Ensure — create when missing (first deploy, or archived out-of-band).
      if (current === undefined) {
        const residency = news.dataResidency;
        current = yield* Anthropic.createWorkspace({
          name,
          display_color: news.displayColor,
          external_key_id: news.externalKeyId,
          tags: desiredTags,
          data_residency:
            residency === undefined
              ? undefined
              : {
                  workspace_geo: residency.workspaceGeo,
                  allowed_inference_geos: residency.allowedInferenceGeos,
                  default_inference_geo: residency.defaultInferenceGeo,
                },
        });
      }

      // Sync — diff observed cloud state against desired, send only deltas.
      const observedTags = tagRecord(current.tags);
      const { upsert, removed } = diffTags(observedTags, desiredTags);
      const tagPatch =
        upsert.length > 0 || removed.length > 0
          ? {
              ...Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
              // Tag updates are a merge-patch: `null` removes a key.
              ...Object.fromEntries(removed.map((key) => [key, null])),
            }
          : undefined;

      const desiredResidency = news.dataResidency;
      const observedAllowed = toAllowedGeos(current.data_residency.allowed_inference_geos);
      const allowedChanged =
        desiredResidency?.allowedInferenceGeos !== undefined &&
        !sameGeos(observedAllowed, desiredResidency.allowedInferenceGeos);
      const defaultChanged =
        desiredResidency?.defaultInferenceGeo !== undefined &&
        desiredResidency.defaultInferenceGeo !== current.data_residency.default_inference_geo;

      const nameChanged = current.name !== name;
      const colorChanged =
        news.displayColor !== undefined && news.displayColor !== current.display_color;
      const keyChanged =
        news.externalKeyId !== undefined && news.externalKeyId !== current.external_key_id;

      if (
        nameChanged ||
        colorChanged ||
        keyChanged ||
        tagPatch !== undefined ||
        allowedChanged ||
        defaultChanged
      ) {
        current = yield* Anthropic.updateWorkspace({
          workspace_id: current.id,
          name: nameChanged ? name : undefined,
          display_color: colorChanged ? news.displayColor : undefined,
          external_key_id: keyChanged ? news.externalKeyId : undefined,
          tags: tagPatch,
          data_residency:
            allowedChanged || defaultChanged
              ? {
                  allowed_inference_geos: allowedChanged
                    ? desiredResidency?.allowedInferenceGeos
                    : undefined,
                  default_inference_geo: defaultChanged
                    ? desiredResidency?.defaultInferenceGeo
                    : undefined,
                }
              : undefined,
        });
      }

      return toAttrs(current);
    }),

    // Anthropic offers no Workspace delete — archiving is the terminal state.
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.workspaceId);
      if (current === undefined) return;
      yield* Anthropic.archiveWorkspace({ workspace_id: output.workspaceId }).pipe(
        Effect.catchTag("ResourceNotFound", () => Effect.void),
      );
    }),
  });
