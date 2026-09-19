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
  findMembership,
  getMembership,
  ignoreMissing,
  lastSegment,
  listOwnedMembers,
  membershipMemberOf,
  membershipParentOf,
  sameText,
  toGroupResourceName,
  toMembershipName,
  toSpaceName,
  toUserResourceName,
} from "./internal.ts";

export type SpacesMemberUser = {
  /** Resource name `users/{user}`. */
  name?: string;
  /** User type (`HUMAN` or `BOT`). */
  type?: string;
  /** Display name, when returned. */
  displayName?: string;
  /** Domain id, when returned. */
  domainId?: string;
  /** Whether the user is anonymous or deleted. */
  isAnonymous?: boolean;
};

export type SpacesMemberProps = {
  /**
   * Parent space (`spaces/{space}` or `{space}`). Immutable — changing
   * it replaces the membership.
   */
  parent: string;
  /**
   * Resource name `spaces/{space}/members/{member}`. Server-assigned on
   * create. Immutable — changing it replaces the membership.
   */
  membershipName?: string;
  /**
   * User to add (`users/{user}`, email, or `users/app`). Immutable —
   * changing it replaces the membership.
   */
  memberName?: string;
  /**
   * User type when `memberName` is set.
   * @default "HUMAN"
   */
  memberType?: chat.UserTypeEnum | (string & {});
  /**
   * Google Group to add (`groups/{group}`). Immutable — changing it
   * replaces the membership.
   */
  groupName?: string;
  /**
   * Role in the space. Updates in place.
   */
  role?: chat.MembershipRoleEnum | (string & {});
};

export type SpacesMember = Resource<
  "GCP.Chat.SpacesMember",
  SpacesMemberProps,
  {
    /** Full resource name `spaces/{space}/members/{member}`. */
    name: string;
    /** Parent space name. */
    parent: string;
    /** Member id (last path segment). */
    memberId: string;
    /** Project id used when the membership was reconciled. */
    project: string;
    /** User member, when this is a user membership. */
    member: SpacesMemberUser | undefined;
    /** Google Group name, when this is a group membership. */
    groupName: string | undefined;
    /** Role. */
    role: string | undefined;
    /** Membership state. */
    state: string | undefined;
    /** Affiliation to the owning organization. */
    affiliation: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 deletion timestamp, when the member has left. */
    deleteTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Chat space membership.
 *
 * Memberships have no labels or description, so Alchemy treats identity
 * as `(parent, member)` and lists memberships of alchemy-owned spaces
 * (ownership stamped on the parent space) for `list` / nuke. Role
 * updates in place. Changing parent, user, or group replaces the
 * membership.
 *
 * ### Creating a Membership
 * **Example:** Add a user by email
 * ```typescript
 * const member = yield* GCP.Chat.SpacesMember("Ada", {
 *   parent: space.name,
 *   memberName: "ada@example.com",
 * });
 * ```
 *
 * **Example:** Add a Google Group as a manager
 * ```typescript
 * const member = yield* GCP.Chat.SpacesMember("Eng", {
 *   parent: space.name,
 *   groupName: "groups/eng@example.com",
 *   role: "ROLE_MANAGER",
 * });
 * ```
 *
 * ### Updating a Membership
 * **Example:** Promote to manager
 * ```typescript
 * const member = yield* GCP.Chat.SpacesMember("Ada", {
 *   parent: existing.parent,
 *   membershipName: existing.name,
 *   memberName: "ada@example.com",
 *   role: "ROLE_MANAGER",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Chat
 */
export const SpacesMember = Resource<SpacesMember>("GCP.Chat.SpacesMember");

export class SpacesMemberNotResolved extends Data.TaggedError(
  "GCP.Chat.SpacesMemberNotResolved",
)<{
  name: string;
}> {}

const userOf = (user: chat.User | undefined): SpacesMemberUser | undefined => {
  if (user === undefined) return undefined;
  return {
    name: user.name,
    type: user.type,
    displayName: user.displayName,
    domainId: user.domainId,
    isAnonymous: user.isAnonymous,
  };
};

const toAttrs = (membership: chat.Membership, project: string) => {
  const name = membership.name ?? "";
  return {
    name,
    parent: membershipParentOf(name),
    memberId: membershipMemberOf(name) || lastSegment(name),
    project,
    member: userOf(membership.member),
    groupName: membership.groupMember?.name,
    role: membership.role,
    state: membership.state,
    affiliation: membership.affiliation,
    createTime: membership.createTime,
    deleteTime: membership.deleteTime,
  };
};

const desiredMember = (news: SpacesMemberProps) => {
  if (news.memberName !== undefined && news.memberName.length > 0) {
    return {
      name: toUserResourceName(news.memberName),
      type: news.memberType ?? "HUMAN",
    };
  }
  return undefined;
};

const desiredGroup = (news: SpacesMemberProps) => {
  if (news.groupName !== undefined && news.groupName.length > 0) {
    return { name: toGroupResourceName(news.groupName) };
  }
  return undefined;
};

export const SpacesMemberProvider = () =>
  Provider.succeed(SpacesMember, {
    stables: ["name", "parent", "memberId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toSpaceName(news.parent) !== toSpaceName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousName = olds?.membershipName ?? output?.name;
      if (
        previousName !== undefined &&
        news.membershipName !== undefined &&
        news.membershipName !== previousName &&
        toMembershipName(news.parent, news.membershipName) !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousMember = olds?.memberName ?? output?.member?.name;
      if (
        previousMember !== undefined &&
        news.memberName !== undefined &&
        toUserResourceName(news.memberName) !==
          toUserResourceName(previousMember) &&
        news.memberName !== output?.memberId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousGroup = olds?.groupName ?? output?.groupName;
      if (
        previousGroup !== undefined &&
        news.groupName !== undefined &&
        toGroupResourceName(news.groupName) !==
          toGroupResourceName(previousGroup)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const existing = yield* findMembership(
        parent,
        olds?.memberName ?? output?.member?.name,
        olds?.groupName ?? output?.groupName,
        olds?.membershipName ?? output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const members = yield* listOwnedMembers();
        return members.map((membership) => toAttrs(membership, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toSpaceName(news.parent);
      const member = desiredMember(news);
      const groupMember = desiredGroup(news);

      let current = yield* findMembership(
        parent,
        news.memberName ?? output?.member?.name,
        news.groupName ?? output?.groupName,
        news.membershipName ?? output?.name,
      );

      if (current === undefined) {
        const created = yield* chat
          .createSpacesMembers({
            parent,
            body: {
              member,
              groupMember,
              role: news.role,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findMembership(
                parent,
                news.memberName ?? output?.member?.name,
                news.groupName ?? output?.groupName,
                news.membershipName ?? output?.name,
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SpacesMemberNotResolved({
          name:
            news.membershipName ??
            toMembershipName(
              parent,
              news.memberName ?? news.groupName ?? output?.name ?? "",
            ),
        });
      }

      const name = current.name ?? output?.name ?? "";
      if (news.role !== undefined && !sameText(current.role, news.role)) {
        current = yield* chat.patchSpacesMembers({
          name,
          updateMask: "role",
          body: { role: news.role },
        });
      }

      const fresh = (yield* getMembership(name)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* ignoreMissing(chat.deleteSpacesMembers({ name: output.name }));
    }),
  });
