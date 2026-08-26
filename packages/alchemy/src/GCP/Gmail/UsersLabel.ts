import * as gmail from "@distilled.cloud/gcp/gmail_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_USER,
  encodeOwnershipLine,
  findLabelByName,
  getLabel,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listLabels,
  MAX_LABEL_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toGeneratedName,
  toUserId,
} from "./internal.ts";

export type UsersLabelColor = {
  /** Background color as `#RRGGBB` from Gmail's allowed set. */
  backgroundColor?: string;
  /** Text color as `#RRGGBB` from Gmail's allowed set. */
  textColor?: string;
};

export type UsersLabelProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Gmail-assigned label id. Server-assigned on create. Immutable —
   * changing it replaces the label.
   */
  labelId?: string;
  /**
   * Display name (max 225 characters including Alchemy's ownership
   * marker). Gmail labels have no labels field, so ownership is stored
   * in a `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
  /**
   * Visibility of messages with this label in the message list.
   */
  messageListVisibility?: gmail.LabelMessageListVisibilityEnum | (string & {});
  /**
   * Visibility of the label in the Gmail label list.
   */
  labelListVisibility?: gmail.LabelLabelListVisibilityEnum | (string & {});
  /**
   * Color for user labels. Both background and text must be from Gmail's
   * allowed set.
   */
  color?: UsersLabelColor;
};

export type UsersLabel = Resource<
  "GCP.Gmail.UsersLabel",
  UsersLabelProps,
  {
    /** Gmail-assigned label id. */
    labelId: string;
    /** Mailbox the label belongs to. */
    userId: string;
    /** Project id used when the label was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Message-list visibility. */
    messageListVisibility: string | undefined;
    /** Label-list visibility. */
    labelListVisibility: string | undefined;
    /** Owner type (`user` or `system`). */
    type: string | undefined;
    /** Color, when set. */
    color: UsersLabelColor | undefined;
    /** Total messages with this label. */
    messagesTotal: number | undefined;
    /** Unread messages with this label. */
    messagesUnread: number | undefined;
    /** Total threads with this label. */
    threadsTotal: number | undefined;
    /** Unread threads with this label. */
    threadsUnread: number | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail user label.
 *
 * Gmail labels have no labels field, so Alchemy stamps ownership into
 * `name` for `list` / nuke. The mailbox (`userId`) and Gmail id are
 * identity — changing either replaces the label. Name, visibility, and
 * color update in place. System labels cannot be created or deleted.
 *
 * ### Creating a Label
 * **Example:** Generated name
 * ```typescript
 * const label = yield* GCP.Gmail.UsersLabel("Receipts", {});
 * ```
 *
 * **Example:** Explicit name and visibility
 * ```typescript
 * const label = yield* GCP.Gmail.UsersLabel("Receipts", {
 *   name: "Receipts",
 *   labelListVisibility: "labelShow",
 *   messageListVisibility: "show",
 * });
 * ```
 *
 * ### Updating a Label
 * **Example:** Rename
 * ```typescript
 * const label = yield* GCP.Gmail.UsersLabel("Receipts", {
 *   labelId: existing.labelId,
 *   name: "Receipts 2026",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersLabel = Resource<UsersLabel>("GCP.Gmail.UsersLabel");

export class UsersLabelNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersLabelNotResolved",
)<{
  userId: string;
  labelId: string;
}> {}

const colorOf = (
  color: gmail.LabelColor | undefined,
): UsersLabelColor | undefined => {
  if (color === undefined) return undefined;
  return {
    backgroundColor: color.backgroundColor,
    textColor: color.textColor,
  };
};

const toAttrs = (label: gmail.Label, userId: string, project: string) => ({
  labelId: label.id ?? "",
  userId,
  project,
  name: parseOwnership(label.name).text,
  messageListVisibility: label.messageListVisibility,
  labelListVisibility: label.labelListVisibility,
  type: label.type,
  color: colorOf(label.color),
  messagesTotal: label.messagesTotal,
  messagesUnread: label.messagesUnread,
  threadsTotal: label.threadsTotal,
  threadsUnread: label.threadsUnread,
});

export const UsersLabelProvider = () =>
  Provider.succeed(UsersLabel, {
    stables: ["labelId", "userId", "project", "type"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.labelId ?? output?.labelId;
      if (
        previousId !== undefined &&
        news.labelId !== undefined &&
        news.labelId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const labelId = olds?.labelId ?? output?.labelId ?? "";
      let existing = yield* getLabel(userId, labelId);
      if (existing === undefined) {
        const ownership = yield* ownershipLabels(id);
        const name = encodeOwnershipLine(
          ownership,
          olds?.name ?? output?.name,
          MAX_LABEL_NAME_LENGTH,
        );
        existing = yield* findLabelByName(userId, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const labels = yield* listLabels(DEFAULT_USER);
        return labels
          .filter((label) => hasOwnershipMarker(label.name))
          .map((label) => toAttrs(label, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const ownership = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(id, news.name, output?.name);
      const name = encodeOwnershipLine(
        ownership,
        displayName,
        MAX_LABEL_NAME_LENGTH,
      );
      const desired: gmail.Label = {
        name,
        messageListVisibility: news.messageListVisibility,
        labelListVisibility: news.labelListVisibility,
        color: news.color,
      };

      let current = yield* getLabel(
        userId,
        news.labelId ?? output?.labelId ?? "",
      );
      if (current === undefined) {
        current = yield* findLabelByName(userId, name);
      }

      if (current === undefined) {
        const created = yield* gmail
          .createUsersLabels({ userId, body: desired })
          .pipe(
            Effect.catchTag("Conflict", () => findLabelByName(userId, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersLabelNotResolved({
          userId,
          labelId: news.labelId ?? output?.labelId ?? name,
        });
      }

      const labelId = current.id ?? news.labelId ?? output?.labelId ?? "";
      const nameChanged = !sameText(current.name, name);
      const messageVisChanged =
        news.messageListVisibility !== undefined &&
        !sameText(current.messageListVisibility, news.messageListVisibility);
      const labelVisChanged =
        news.labelListVisibility !== undefined &&
        !sameText(current.labelListVisibility, news.labelListVisibility);
      const colorChanged =
        news.color !== undefined &&
        !jsonEqual(colorOf(current.color), news.color);

      if (nameChanged || messageVisChanged || labelVisChanged || colorChanged) {
        current = yield* gmail.patchUsersLabels({
          userId,
          id: labelId,
          body: desired,
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.labelId.length === 0) return;
      if (output.type === "system") return;
      yield* ignoreMissing(
        gmail.deleteUsersLabels({
          userId: output.userId || DEFAULT_USER,
          id: output.labelId,
        }),
      );
    }),
  });
