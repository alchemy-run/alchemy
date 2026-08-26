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
  desiredFilterCriteria,
  findOwnedFilter,
  getFilter,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listFilters,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  toUserId,
} from "./internal.ts";

export type UsersSettingsFilterAction = {
  /** Label ids to add. */
  addLabelIds?: string[];
  /** Label ids to remove. */
  removeLabelIds?: string[];
  /** Forward matching messages to this address. */
  forward?: string;
};

export type UsersSettingsFilterCriteria = {
  /** Gmail search query that must not match. */
  negatedQuery?: string;
  /** How `size` is compared (`smaller` or `larger`). */
  sizeComparison?: gmail.FilterCriteriaSizeComparisonEnum | (string & {});
  /** Exclude chats from matching. */
  excludeChats?: boolean;
  /** RFC822 size in bytes. */
  size?: number;
  /** Sender display name or email. */
  from?: string;
  /** Gmail search query that must match. */
  query?: string;
  /**
   * Subject phrase. Gmail filters have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  subject?: string;
  /** Recipient display name or email. */
  to?: string;
  /** Whether the message has an attachment. */
  hasAttachment?: boolean;
};

export type UsersSettingsFilterProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Gmail-assigned filter id. Server-assigned on create. Immutable —
   * changing it replaces the filter.
   */
  filterId?: string;
  /**
   * Matching criteria. Gmail has no filter update API — changing
   * criteria replaces the filter (delete-first).
   */
  criteria?: UsersSettingsFilterCriteria;
  /**
   * Action applied to matching messages. Gmail has no filter update
   * API — changing the action replaces the filter (delete-first).
   */
  action?: UsersSettingsFilterAction;
};

export type UsersSettingsFilter = Resource<
  "GCP.Gmail.UsersSettingsFilter",
  UsersSettingsFilterProps,
  {
    /** Gmail-assigned filter id. */
    filterId: string;
    /** Mailbox the filter belongs to. */
    userId: string;
    /** Project id used when the filter was reconciled. */
    project: string;
    /** Criteria with the Alchemy ownership prefix stripped from subject. */
    criteria: UsersSettingsFilterCriteria | undefined;
    /** Action. */
    action: UsersSettingsFilterAction | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail filter on the user's mailbox.
 *
 * Gmail filters have no labels field, so Alchemy stamps ownership into
 * `criteria.subject` for `list` / nuke. There is no update API —
 * changing criteria or action replaces the filter (delete-first).
 *
 * ### Creating a Filter
 * **Example:** Star messages matching a subject
 * ```typescript
 * const filter = yield* GCP.Gmail.UsersSettingsFilter("StarNotes", {
 *   criteria: { subject: "runbook" },
 *   action: { addLabelIds: ["STARRED"] },
 * });
 * ```
 *
 * **Example:** Archive mail from a sender
 * ```typescript
 * const filter = yield* GCP.Gmail.UsersSettingsFilter("ArchiveBot", {
 *   criteria: { from: "bot@example.com" },
 *   action: { removeLabelIds: ["INBOX"] },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsFilter = Resource<UsersSettingsFilter>(
  "GCP.Gmail.UsersSettingsFilter",
);

export class UsersSettingsFilterNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsFilterNotResolved",
)<{
  userId: string;
  filterId: string;
}> {}

const criteriaOf = (
  criteria: gmail.FilterCriteria | undefined,
): UsersSettingsFilterCriteria | undefined => {
  if (criteria === undefined) return undefined;
  return {
    negatedQuery: criteria.negatedQuery,
    sizeComparison: criteria.sizeComparison,
    excludeChats: criteria.excludeChats,
    size: criteria.size,
    from: criteria.from,
    query: criteria.query,
    subject: parseOwnership(criteria.subject).text,
    to: criteria.to,
    hasAttachment: criteria.hasAttachment,
  };
};

const actionOf = (
  action: gmail.FilterAction | undefined,
): UsersSettingsFilterAction | undefined => {
  if (action === undefined) return undefined;
  return {
    addLabelIds: action.addLabelIds,
    removeLabelIds: action.removeLabelIds,
    forward: action.forward,
  };
};

const toAttrs = (filter: gmail.Filter, userId: string, project: string) => ({
  filterId: filter.id ?? "",
  userId,
  project,
  criteria: criteriaOf(filter.criteria),
  action: actionOf(filter.action),
});

const ownershipText = (filter: gmail.Filter) =>
  filter.criteria?.subject ?? filter.criteria?.query;

export const UsersSettingsFilterProvider = () =>
  Provider.succeed(UsersSettingsFilter, {
    stables: ["filterId", "userId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.filterId ?? output?.filterId;
      if (
        previousId !== undefined &&
        news.filterId !== undefined &&
        news.filterId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousCriteria = olds?.criteria ?? output?.criteria;
      if (
        news.criteria !== undefined &&
        previousCriteria !== undefined &&
        !jsonEqual(
          { ...previousCriteria, subject: previousCriteria.subject },
          { ...news.criteria, subject: news.criteria.subject },
        )
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousAction = olds?.action ?? output?.action;
      if (
        news.action !== undefined &&
        previousAction !== undefined &&
        !jsonEqual(previousAction, news.action)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const filterId = olds?.filterId ?? output?.filterId ?? "";
      let existing = yield* getFilter(userId, filterId);
      if (existing === undefined) {
        existing = yield* findOwnedFilter(userId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const filters = yield* listFilters(DEFAULT_USER);
        return filters
          .filter((filter) => hasOwnershipMarker(ownershipText(filter)))
          .map((filter) => toAttrs(filter, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const ownership = yield* ownershipLabels(id);
      const criteria = desiredFilterCriteria(ownership, news.criteria);
      const action: gmail.FilterAction | undefined = news.action
        ? {
            addLabelIds: news.action.addLabelIds,
            removeLabelIds: news.action.removeLabelIds,
            forward: news.action.forward,
          }
        : undefined;
      const desired: gmail.Filter = { criteria, action };

      let current = yield* getFilter(
        userId,
        news.filterId ?? output?.filterId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedFilter(userId, id);
      }

      if (current === undefined) {
        const created = yield* gmail
          .createUsersSettingsFilters({ userId, body: desired })
          .pipe(Effect.catchTag("Conflict", () => findOwnedFilter(userId, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsFilterNotResolved({
          userId,
          filterId: news.filterId ?? output?.filterId ?? "",
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.filterId.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersSettingsFilters({
          userId: output.userId || DEFAULT_USER,
          id: output.filterId,
        }),
      );
    }),
  });
