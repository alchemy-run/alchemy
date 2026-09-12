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
} from "./internal.ts";

export type CollectionsEnginesConversationProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the conversation.
   */
  engine: string;
  /**
   * User tracking id. Conversations have no labels or display name, so
   * Alchemy stamps ownership into this field for list / nuke.
   */
  userPseudoId?: string;
  /**
   * Conversation state.
   */
  state?: discoveryengine.GoogleCloudDiscoveryengineV1ConversationStateEnum;
  /**
   * Conversation messages.
   */
  messages?: discoveryengine.GoogleCloudDiscoveryengineV1ConversationMessageList;
};

export type CollectionsEnginesConversation = Resource<
  "GCP.Discoveryengine.CollectionsEnginesConversation",
  CollectionsEnginesConversationProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversation id (last path segment). */
    conversationId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** User tracking id with the Alchemy ownership prefix stripped. */
    userPseudoId: string | undefined;
    /** Conversation state. */
    state: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Conversation on a collection Engine.
 *
 * The API assigns the conversation id. Conversations have no labels, so
 * Alchemy stamps ownership into `userPseudoId` for `list` / nuke.
 * Parent engine is immutable; state and messages update in place.
 *
 * ### Creating a Conversation
 * **Example:** Empty conversation
 * ```typescript
 * const conversation =
 *   yield* GCP.Discoveryengine.CollectionsEnginesConversation("Chat", {
 *     engine: engine.name,
 *   });
 * ```
 *
 * ### Updating a Conversation
 * **Example:** Complete the conversation
 * ```typescript
 * const conversation =
 *   yield* GCP.Discoveryengine.CollectionsEnginesConversation("Chat", {
 *     engine: existing.engine,
 *     state: "COMPLETED",
 *   });
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsEnginesConversation =
  Resource<CollectionsEnginesConversation>(
    "GCP.Discoveryengine.CollectionsEnginesConversation",
  );

export class CollectionsEnginesConversationNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsEnginesConversationNotResolved",
)<{
  name: string;
}> {}

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesConversations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByEngine = (engine: string) =>
  discoveryengine.listProjectsLocationsCollectionsEnginesConversations
    .pages({ parent: engine, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.conversations ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const toAttrs = (
  conversation: discoveryengine.GoogleCloudDiscoveryengineV1Conversation,
  project: string,
) => {
  const name = conversation.name ?? "";
  const parsed = parseResourceName(name, "conversations");
  const ownership = parseOwnership(conversation.userPseudoId);
  return {
    name,
    conversationId: parsed.id,
    engine: parentBefore(name, "conversations"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    userPseudoId: ownership.text,
    state: conversation.state,
    startTime: conversation.startTime,
    endTime: conversation.endTime,
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
      const { labels } = parseOwnership(item.userPseudoId);
      if (yield* hasAlchemyLabels(id, labels)) return item;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Conversation
      | undefined;
  });

export const CollectionsEnginesConversationProvider = () =>
  Provider.succeed(CollectionsEnginesConversation, {
    stables: [
      "name",
      "conversationId",
      "engine",
      "project",
      "location",
      "collectionId",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      if (previousEngine !== undefined && news.engine !== previousEngine) {
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
      const { labels } = parseOwnership(existing.userPseudoId);
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
            if (hasOwnershipMarker(item.userPseudoId)) {
              rows.push(toAttrs(item, env.project));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const userPseudoId = encodeOwnership(ownership, news.userPseudoId);
      const fallbackName = output?.name ?? `${news.engine}/conversations/-`;

      let current = yield* findOwned(id, news.engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesConversations({
            parent: news.engine,
            body: {
              userPseudoId,
              state: news.state,
              messages: news.messages,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* findOwned(id, news.engine);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesConversationNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const userChanged = (current.userPseudoId ?? "") !== userPseudoId;
      const stateChanged = (current.state ?? "") !== (news.state ?? "");
      const messagesChanged = !sameJson(current.messages, news.messages);

      if (userChanged || stateChanged || messagesChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesConversations(
            {
              name,
              updateMask: [
                userChanged ? "user_pseudo_id" : undefined,
                stateChanged ? "state" : undefined,
                messagesChanged ? "messages" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                userPseudoId,
                state: news.state,
                messages: news.messages,
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
        .deleteProjectsLocationsCollectionsEnginesConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
