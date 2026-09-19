import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  expandDataStore,
  hasOwnershipMarker,
  internalLabels,
  listProjectDataStores,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
} from "./internal.ts";

export type DataStoresConversationProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the conversation.
   */
  dataStore: string;
  /**
   * Unique identifier for tracking users. Alchemy stamps ownership into
   * this field (conversations have no labels or display name) so `list`
   * / nuke can find the conversation. If omitted, an ownership marker is
   * used.
   */
  userPseudoId?: string;
  /**
   * Conversation state (`IN_PROGRESS`, `COMPLETED`).
   */
  state?: string;
};

export type DataStoresConversation = Resource<
  "GCP.Discoveryengine.DataStoresConversation",
  DataStoresConversationProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/conversations/{id}`. */
    name: string;
    /** Conversation id (last path segment). Server-assigned on create. */
    conversationId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User pseudo id with the Alchemy ownership prefix stripped. */
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
 * A Vertex AI Search Conversation attached to a Data Store.
 *
 * Conversations have no labels or display name, so Alchemy stamps
 * ownership into `userPseudoId` for `list` / nuke. The conversation id
 * is server-assigned. Parent is immutable; user id and state update in
 * place.
 *
 * ### Creating a Conversation
 * **Example:** Start a conversation
 * ```typescript
 * const conversation = yield* GCP.Discoveryengine.DataStoresConversation(
 *   "Support",
 *   { dataStore: dataStore.name },
 * );
 * ```
 *
 * ### Updating a Conversation
 * **Example:** Mark completed
 * ```typescript
 * const conversation = yield* GCP.Discoveryengine.DataStoresConversation(
 *   "Support",
 *   {
 *     dataStore: existing.dataStore,
 *     state: "COMPLETED",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const DataStoresConversation = Resource<DataStoresConversation>(
  "GCP.Discoveryengine.DataStoresConversation",
);

export class DataStoresConversationNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.DataStoresConversationNotResolved",
)<{
  name: string;
}> {}

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
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    userPseudoId: ownership.text,
    state: conversation.state,
    startTime: conversation.startTime,
    endTime: conversation.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresConversations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsDataStoresConversations
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.conversations ?? [])),
      Stream.filter((conversation) =>
        hasOwnershipMarker(conversation.userPseudoId),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (id: string, parent: string | undefined, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    if (parent === undefined) return undefined;
    const conversations = yield* listAtParent(parent);
    for (const conversation of conversations) {
      if (yield* ownedByAlchemy(id, conversation.userPseudoId)) {
        return conversation;
      }
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Conversation
      | undefined;
  });

export const DataStoresConversationProvider = () =>
  Provider.succeed(DataStoresConversation, {
    stables: [
      "name",
      "conversationId",
      "dataStore",
      "project",
      "location",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const existing = yield* findOwned(id, parent, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.userPseudoId))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listProjectDataStores(env.project);
        const pages = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listAtParent(store.name).pipe(
                  Effect.map((conversations) =>
                    conversations.map((conversation) =>
                      toAttrs(conversation, env.project),
                    ),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const labels = yield* internalLabels(id);
      const userPseudoId = encodeOwnership(labels, news.userPseudoId);

      let current = yield* findOwned(id, parent, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresConversations({
            parent,
            body: {
              userPseudoId,
              state: news.state,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(id, parent)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresConversationNotResolved({
          name: output?.name ?? `${parent}/conversations`,
        });
      }

      const userChanged = (current.userPseudoId ?? "") !== userPseudoId;
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;

      if (userChanged || stateChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresConversations({
            name: current.name ?? "",
            updateMask: [
              userChanged ? "user_pseudo_id" : undefined,
              stateChanged ? "state" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name,
              userPseudoId,
              state: news.state,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
