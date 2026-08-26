import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  listEngines,
  ownershipLabels,
  parentBefore,
  parseOwnership,
  parseResourceName,
  sameJson,
  toResourceId,
} from "./internal.ts";

export type CollectionsEnginesAssistantProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the assistant.
   */
  engine: string;
  /**
   * Assistant id. If omitted, a unique RFC-1034 id is generated.
   * Immutable — changing it replaces the assistant.
   */
  assistantId?: string;
  /**
   * User-facing display name (max 128 characters).
   */
  displayName?: string;
  /**
   * Configuration description. Assistants have no labels field, so
   * Alchemy stamps ownership into this field for list / nuke.
   */
  description?: string;
  /**
   * Web grounding type.
   */
  webGroundingType?: discoveryengine.GoogleCloudDiscoveryengineV1AssistantWebGroundingTypeEnum;
  /**
   * When true, the default web-grounding toggle is off in the UI.
   * @default false
   */
  defaultWebGroundingToggleOff?: boolean;
  /**
   * Generation configuration (language, model, system instruction).
   */
  generationConfig?: discoveryengine.GoogleCloudDiscoveryengineV1AssistantGenerationConfig;
  /**
   * Customer policy (banned phrases, Model Armor).
   */
  customerPolicy?: discoveryengine.GoogleCloudDiscoveryengineV1AssistantCustomerPolicy;
};

export type CollectionsEnginesAssistant = Resource<
  "GCP.Discoveryengine.CollectionsEnginesAssistant",
  CollectionsEnginesAssistantProps,
  {
    /** Full resource name. */
    name: string;
    /** Assistant id (last path segment). */
    assistantId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** User display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Web grounding type. */
    webGroundingType: string | undefined;
    /** Whether the default web-grounding toggle is off. */
    defaultWebGroundingToggleOff: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Assistant attached to a collection Engine.
 *
 * Assistants have no labels, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent engine and assistant id are
 * immutable; display name, description, grounding, and generation
 * config update in place.
 *
 * ### Creating an Assistant
 * **Example:** Assistant on a search engine
 * ```typescript
 * const engine = yield* GCP.Discoveryengine.CollectionsEngine("Search", {
 *   dataStoreIds: [store.dataStoreId],
 * });
 * const assistant = yield* GCP.Discoveryengine.CollectionsEnginesAssistant(
 *   "Help",
 *   {
 *     engine: engine.name,
 *     displayName: "docs helper",
 *   },
 * );
 * ```
 *
 * ### Updating an Assistant
 * **Example:** Rename
 * ```typescript
 * const assistant = yield* GCP.Discoveryengine.CollectionsEnginesAssistant(
 *   "Help",
 *   {
 *     engine: existing.engine,
 *     assistantId: existing.assistantId,
 *     displayName: "docs helper prod",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsEnginesAssistant =
  Resource<CollectionsEnginesAssistant>(
    "GCP.Discoveryengine.CollectionsEnginesAssistant",
  );

export class CollectionsEnginesAssistantNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsEnginesAssistantNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, assistantId: string) =>
  `${engine}/assistants/${assistantId}`;

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesAssistants({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByEngine = (engine: string) =>
  discoveryengine.listProjectsLocationsCollectionsEnginesAssistants
    .pages({ parent: engine, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.assistants ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const toAttrs = (
  assistant: discoveryengine.GoogleCloudDiscoveryengineV1Assistant,
  project: string,
) => {
  const name = assistant.name ?? "";
  const parsed = parseResourceName(name, "assistants");
  const ownership = parseOwnership(assistant.description);
  return {
    name,
    assistantId: parsed.id,
    engine: parentBefore(name, "assistants"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: assistant.displayName,
    description: ownership.text,
    webGroundingType: assistant.webGroundingType,
    defaultWebGroundingToggleOff:
      assistant.defaultWebGroundingToggleOff === true,
    createTime: assistant.createTime,
    updateTime: assistant.updateTime,
  };
};

const findOwned = (id: string, engine: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const items = yield* listByEngine(engine);
    for (const item of items) {
      const { labels } = parseOwnership(item.description);
      if (yield* hasAlchemyLabels(id, labels)) return item;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Assistant
      | undefined;
  });

export const CollectionsEnginesAssistantProvider = () =>
  Provider.succeed(CollectionsEnginesAssistant, {
    stables: [
      "name",
      "assistantId",
      "engine",
      "project",
      "location",
      "collectionId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.assistantId ?? output?.assistantId;
      const nextId = news.assistantId ?? previousId;
      if (
        (previousEngine !== undefined && news.engine !== previousEngine) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engine = olds?.engine ?? output?.engine;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : engine !== undefined
            ? yield* findOwned(id, engine)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = yield* listEngines(env.project);
        const rows: ReturnType<typeof toAttrs>[] = [];
        for (const engine of engines) {
          if (engine.name === undefined) continue;
          const items = yield* listByEngine(engine.name);
          for (const item of items) {
            if (hasOwnershipMarker(item.description)) {
              rows.push(toAttrs(item, env.project));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const assistantId = yield* toResourceId(
        id,
        news.assistantId,
        output?.assistantId,
      );
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description, "\n");
      const displayName = news.displayName ?? assistantId;
      const fallbackName =
        output?.name ?? resourceName(news.engine, assistantId);
      const groundingOff = news.defaultWebGroundingToggleOff === true;

      let current = yield* findOwned(id, news.engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesAssistants({
            parent: news.engine,
            assistantId,
            body: {
              displayName,
              description,
              webGroundingType: news.webGroundingType,
              defaultWebGroundingToggleOff: groundingOff ? true : undefined,
              generationConfig: news.generationConfig,
              customerPolicy: news.customerPolicy,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* findOwned(id, news.engine);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesAssistantNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged = (current.description ?? "") !== description;
      const groundingTypeChanged =
        (current.webGroundingType ?? "") !== (news.webGroundingType ?? "");
      const groundingOffChanged =
        (current.defaultWebGroundingToggleOff === true) !== groundingOff;
      const generationChanged = !sameJson(
        current.generationConfig,
        news.generationConfig,
      );
      const policyChanged = !sameJson(
        current.customerPolicy,
        news.customerPolicy,
      );

      if (
        displayNameChanged ||
        descriptionChanged ||
        groundingTypeChanged ||
        groundingOffChanged ||
        generationChanged ||
        policyChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesAssistants(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                descriptionChanged ? "description" : undefined,
                groundingTypeChanged ? "web_grounding_type" : undefined,
                groundingOffChanged
                  ? "default_web_grounding_toggle_off"
                  : undefined,
                generationChanged ? "generation_config" : undefined,
                policyChanged ? "customer_policy" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                description,
                webGroundingType: news.webGroundingType,
                defaultWebGroundingToggleOff: groundingOff,
                generationConfig: news.generationConfig,
                customerPolicy: news.customerPolicy,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesAssistants({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
