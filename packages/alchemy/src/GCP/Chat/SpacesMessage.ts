import * as chat from "@distilled.cloud/gcp/chat_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwnedMessage,
  getMessage,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listOwnedMessages,
  messageParentOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toClientMessageId,
  toGeneratedName,
  toMessageName,
  toSpaceName,
} from "./internal.ts";

export type SpacesMessageThread = {
  /** Resource name `spaces/{space}/threads/{thread}`. */
  name?: string;
  /** Client-assigned thread key. */
  threadKey?: string;
};

export type SpacesMessageProps = {
  /**
   * Parent space (`spaces/{space}` or `{space}`). Immutable — changing
   * it replaces the message.
   */
  parent: string;
  /**
   * Client-assigned message id (`client-…`) or the `{message}` segment
   * of the resource name. Immutable — changing it replaces the message.
   */
  messageId?: string;
  /**
   * Plain-text body. Chat messages have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  text?: string;
  /**
   * Fallback text used when cards cannot be displayed.
   */
  fallbackText?: string;
  /**
   * Thread to start or reply in.
   */
  thread?: SpacesMessageThread;
  /**
   * Whether this message starts a thread or replies to one.
   */
  messageReplyOption?:
    | chat.CreateSpacesMessagesMessageReplyOptionEnum
    | (string & {});
};

export type SpacesMessage = Resource<
  "GCP.Chat.SpacesMessage",
  SpacesMessageProps,
  {
    /** Full resource name `spaces/{space}/messages/{message}`. */
    name: string;
    /** Parent space name. */
    parent: string;
    /** Message id (last path segment or client-assigned id). */
    messageId: string;
    /** Project id used when the message was reconciled. */
    project: string;
    /** User text with the Alchemy ownership prefix stripped. */
    text: string | undefined;
    /** Fallback text. */
    fallbackText: string | undefined;
    /** Client-assigned message id, when set. */
    clientAssignedMessageId: string | undefined;
    /** Thread. */
    thread: SpacesMessageThread | undefined;
    /** Sender, when returned. */
    sender: chat.User | undefined;
    /** Formatted text, when returned. */
    formattedText: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-edit timestamp. */
    lastUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Chat message in a space.
 *
 * Chat messages have no labels field, so Alchemy stamps ownership into
 * `text` and uses a `client-` message id for identity so `list` / nuke
 * can find them. Parent space and message id are identity. Text updates
 * in place.
 *
 * ### Creating a Message
 * **Example:** Text in a space
 * ```typescript
 * const message = yield* GCP.Chat.SpacesMessage("Hello", {
 *   parent: space.name,
 *   text: "hello from alchemy",
 * });
 * ```
 *
 * **Example:** Named message in a thread
 * ```typescript
 * const message = yield* GCP.Chat.SpacesMessage("Hello", {
 *   parent: space.name,
 *   messageId: "client-hello",
 *   text: "hello from alchemy",
 *   thread: { threadKey: "standup" },
 * });
 * ```
 *
 * ### Updating a Message
 * **Example:** Edit the text
 * ```typescript
 * const message = yield* GCP.Chat.SpacesMessage("Hello", {
 *   parent: existing.parent,
 *   messageId: existing.messageId,
 *   text: "updated hello",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Chat
 */
export const SpacesMessage = Resource<SpacesMessage>("GCP.Chat.SpacesMessage");

export class SpacesMessageNotResolved extends Data.TaggedError(
  "GCP.Chat.SpacesMessageNotResolved",
)<{
  name: string;
}> {}

const threadOf = (
  thread: chat.Thread | undefined,
): SpacesMessageThread | undefined => {
  if (thread === undefined) return undefined;
  return {
    name: thread.name,
    threadKey: thread.threadKey,
  };
};

const toAttrs = (message: chat.Message, project: string) => {
  const name = message.name ?? "";
  const parent = message.space?.name ?? messageParentOf(name);
  return {
    name,
    parent,
    messageId: message.clientAssignedMessageId ?? lastSegment(name),
    project,
    text: parseOwnership(message.text).text,
    fallbackText: message.fallbackText,
    clientAssignedMessageId: message.clientAssignedMessageId,
    thread: threadOf(message.thread),
    sender: message.sender,
    formattedText: message.formattedText,
    createTime: message.createTime,
    lastUpdateTime: message.lastUpdateTime,
  };
};

export const SpacesMessageProvider = () =>
  Provider.succeed(SpacesMessage, {
    stables: ["name", "parent", "messageId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toSpaceName(news.parent) !== toSpaceName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.messageId ?? output?.messageId;
      if (
        previousId !== undefined &&
        news.messageId !== undefined &&
        news.messageId !== previousId &&
        news.messageId !== output?.clientAssignedMessageId &&
        toMessageName(news.parent, news.messageId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const messageId = yield* toClientMessageId(
        id,
        olds?.messageId ?? output?.messageId,
        output?.clientAssignedMessageId ?? output?.messageId,
      );
      const name = output?.name || toMessageName(parent, messageId);
      let existing = yield* getMessage(name);
      if (existing === undefined && parent.length > 0) {
        existing = yield* findOwnedMessage(parent, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.text))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const messages = yield* listOwnedMessages();
        return messages
          .filter((message) => hasOwnershipMarker(message.text))
          .map((message) => toAttrs(message, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toSpaceName(news.parent);
      const labels = yield* ownershipLabels(id);
      const userText = yield* toGeneratedName(id, news.text, output?.text, 80);
      const text = encodeOwnership(labels, userText);
      const messageId = yield* toClientMessageId(
        id,
        news.messageId,
        output?.clientAssignedMessageId ?? output?.messageId,
      );
      const requestId = yield* toGeneratedName(
        `${id}-req`,
        undefined,
        output?.messageId,
        63,
      );
      const name = output?.name || toMessageName(parent, messageId);

      let current = yield* getMessage(name);
      if (current === undefined) {
        current = yield* findOwnedMessage(parent, id);
      }

      if (current === undefined) {
        const created = yield* chat
          .createSpacesMessages({
            parent,
            messageId,
            requestId,
            messageReplyOption: news.messageReplyOption,
            threadKey: news.thread?.threadKey,
            body: {
              text,
              fallbackText: news.fallbackText,
              thread: news.thread,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedMessage(parent, id)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SpacesMessageNotResolved({ name });
      }

      const resourceName = current.name ?? name;
      const textChanged = !sameText(current.text, text);
      const fallbackChanged =
        news.fallbackText !== undefined &&
        !sameText(current.fallbackText, news.fallbackText);
      if (textChanged || fallbackChanged) {
        current = yield* chat.patchSpacesMessages({
          name: resourceName,
          updateMask: "text",
          body: { text, fallbackText: news.fallbackText },
        });
      }

      const fresh = (yield* getMessage(resourceName)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* ignoreMissing(chat.deleteSpacesMessages({ name, force: true }));
    }),
  });
