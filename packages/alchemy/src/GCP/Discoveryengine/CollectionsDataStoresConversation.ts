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
  listProjectDataStores,
  ownershipLabels,
  ownershipToken,
  parentOf,
  parseResourceName,
  sameJson,
} from "./internal.ts";

export type ConversationMessage = {
  userInput?: {
    input?: string;
    context?: {
      contextDocuments?: string[];
      activeDocument?: string;
    };
  };
};

export type CollectionsDataStoresConversationProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the conversation.
   */
  dataStore: string;
  /**
   * Conversation state.
   * @default "IN_PROGRESS"
   */
  state?: "STATE_UNSPECIFIED" | "IN_PROGRESS" | "COMPLETED" | (string & {});
  /**
   * End-user id. Conversations have no labels field, so Alchemy stamps
   * ownership into this field for `list` / nuke. User-supplied values are
   * preserved after the ownership token.
   */
  userPseudoId?: string;
  /**
   * Conversation messages.
   */
  messages?: ConversationMessage[];
};

export type CollectionsDataStoresConversation = Resource<
  "GCP.Discoveryengine.CollectionsDataStoresConversation",
  CollectionsDataStoresConversationProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversation id (last path segment). */
    conversationId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Conversation state. */
    state: string | undefined;
    /** User-supplied user pseudo id with the Alchemy token stripped. */
    userPseudoId: string | undefined;
    /** Conversation messages. */
    messages: ConversationMessage[];
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine conversation on a collection data store.
 *
 * Conversations have no labels field, so Alchemy stamps ownership into
 * `userPseudoId` for `list` / nuke. The parent data store is immutable.
 * State and messages update in place. The conversation id is assigned by
 * the API.
 *
 * ### Creating a Conversation
 * **Example:** Open a conversation
 * ```typescript
 * const store = yield* GCP.Discoveryengine.CollectionsDataStore("Docs", {});
 * const chat = yield* GCP.Discoveryengine.CollectionsDataStoresConversation(
 *   "Visitor",
 *   {
 *     dataStore: store.name,
 *     userPseudoId: "user-1",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsDataStoresConversation =
  Resource<CollectionsDataStoresConversation>(
    "GCP.Discoveryengine.CollectionsDataStoresConversation",
  );

export class CollectionsDataStoresConversationNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresConversationNotResolved",
)<{
  name: string;
}> {}

const TOKEN_SEP = "|";

const encodeUserPseudoId = (
  labels: Record<string, string>,
  userPseudoId: string | undefined,
) => {
  const token = ownershipToken(labels);
  return userPseudoId && userPseudoId.length > 0
    ? `${token}${TOKEN_SEP}${userPseudoId}`
    : token;
};

const parseUserPseudoId = (value: string | undefined) => {
  if (value === undefined) {
    return {
      token: undefined as string | undefined,
      userPseudoId: undefined as string | undefined,
    };
  }
  const index = value.indexOf(TOKEN_SEP);
  if (value.startsWith("alc-") && index > 0) {
    return {
      token: value.slice(0, index),
      userPseudoId: value.slice(index + 1),
    };
  }
  if (value.startsWith("alc-")) {
    return { token: value, userPseudoId: undefined };
  }
  return { token: undefined, userPseudoId: value };
};

const toAttrs = (
  conversation: discoveryengine.GoogleCloudDiscoveryengineV1Conversation,
  project: string,
) => {
  const name = conversation.name ?? "";
  const parsed = parseResourceName(name, "conversations");
  const user = parseUserPseudoId(conversation.userPseudoId);
  return {
    name,
    conversationId: parsed.id,
    dataStore: parentOf(name, "conversations"),
    project: parsed.project || project,
    location: parsed.location,
    state: conversation.state,
    userPseudoId: user.userPseudoId,
    messages: (conversation.messages ?? []).map((message) => ({
      userInput: message.userInput
        ? {
            input: message.userInput.input,
            context: message.userInput.context,
          }
        : undefined,
    })),
    startTime: conversation.startTime,
    endTime: conversation.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresConversations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string, filter?: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresConversations
    .pages({ parent, pageSize: 1000, filter })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.conversations ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (
  id: string,
  dataStore: string,
  token: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const filtered = yield* listAtParent(
      dataStore,
      `user_pseudo_id = "${token}"`,
    );
    if (filtered[0] !== undefined) return filtered[0];
    const conversations = yield* listAtParent(dataStore);
    for (const conversation of conversations) {
      const parsed = parseUserPseudoId(conversation.userPseudoId);
      if (parsed.token === token) return conversation;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Conversation
      | undefined;
  });

export const CollectionsDataStoresConversationProvider = () =>
  Provider.succeed(CollectionsDataStoresConversation, {
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
      const ownership = yield* ownershipLabels(id);
      const token = ownershipToken(ownership);
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined
            ? yield* findOwned(id, dataStore, token)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseUserPseudoId(existing.userPseudoId);
      return parsed.token === token ? attrs : Unowned(attrs);
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
                    conversations
                      .filter((conversation) =>
                        conversation.userPseudoId?.startsWith("alc-"),
                      )
                      .map((conversation) =>
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
      const ownership = yield* ownershipLabels(id);
      const token = ownershipToken(ownership);
      const userPseudoId = encodeUserPseudoId(ownership, news.userPseudoId);
      const state = news.state ?? "IN_PROGRESS";

      let current = yield* findOwned(id, news.dataStore, token, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresConversations({
            parent: news.dataStore,
            body: {
              state,
              userPseudoId,
              messages: news.messages,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, news.dataStore, token),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresConversationNotResolved({
          name: output?.name ?? `${news.dataStore}/conversations/-`,
        });
      }

      const resource = current.name ?? "";
      const stateChanged = (current.state ?? "") !== state;
      const userChanged = (current.userPseudoId ?? "") !== userPseudoId;
      const messagesChanged = !sameJson(current.messages, news.messages);

      if (stateChanged || userChanged || messagesChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresConversations(
            {
              name: resource,
              updateMask: [
                stateChanged ? "state" : undefined,
                userChanged ? "user_pseudo_id" : undefined,
                messagesChanged ? "messages" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name: resource,
                state,
                userPseudoId,
                messages: news.messages,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
