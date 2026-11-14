import * as identitystore from "@distilled.cloud/aws/identitystore";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import {
  adoptionAllowed,
  bareIdentifier,
  getUserIdByUserName,
  resolveIdentityStoreId,
  retryIdentityCenter,
} from "./common.ts";

export class GroupMembershipUnexpectedResponse extends Data.TaggedError(
  "GroupMembershipUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GroupMembershipUserNotFound extends Data.TaggedError("GroupMembershipUserNotFound")<{
  readonly message: string;
  readonly userName: string;
  readonly identityStoreId: string;
}> {}

interface GroupMembershipTarget {
  /**
   * Explicit identity store ID.
   * If omitted, Alchemy resolves it from the selected Identity Center instance.
   */
  identityStoreId?: string;
  /**
   * Optional instance ARN used to discover the identity store ID.
   */
  instanceArn?: string;
  /**
   * The group the user joins.
   */
  groupId: string;
}

/** The member, named by `userName` or by `userId`. */
export type GroupMembershipProps = GroupMembershipTarget &
  (
    | {
        /** The member's user name, usually an email address. Resolved with `GetUserId`. */
        userName: string;
        userId?: never;
      }
    | {
        /** The member's user ID in the identity store. */
        userId: string;
        userName?: never;
      }
  );

export interface GroupMembership extends Resource<
  "AWS.IdentityCenter.GroupMembership",
  GroupMembershipProps,
  {
    /** The identity store containing the membership. */
    identityStoreId: string;
    /** The unique ID of the membership. */
    membershipId: string;
    /** The group the user belongs to. */
    groupId: string;
    /** The member's user ID. */
    userId: string;
  },
  never,
  Providers
> {}

/**
 * A user's membership in an IAM Identity Center group. Name the user by
 * `userName` (resolved with `GetUserId` when it deploys) or by `userId`. A
 * membership that already exists requires explicit adoption (`--adopt` or
 * `adopt(true)`). If creation succeeds before its ID is saved, inspect the
 * membership and explicitly adopt it to resume.
 *
 * Changing the user or the group moves the membership: the new one is
 * created, then the old one is deleted. Name a user the same stack manages
 * through its outputs (`alice.userId` or `alice.userName`), so the membership
 * deploys after the user; a literal `userName` that the same deploy renames
 * may be looked up before the rename and fail with
 * `GroupMembershipUserNotFound`. Swapping targets between two memberships in
 * one deploy isn't supported (each may delete the one the other now names);
 * split it across two deploys.
 * ### Adding Members
 * **Example:** Add A User By Name
 * ```typescript
 * yield* GroupMembership("AliceEngineering", {
 *   identityStoreId: idc.identityStoreId,
 *   groupId: engineering.groupId,
 *   userName: "alice@example.com",
 * });
 * ```
 *
 * @resource
 */
export const GroupMembership = Resource<GroupMembership>("AWS.IdentityCenter.GroupMembership");

export const GroupMembershipProvider = () =>
  Provider.effect(
    GroupMembership,
    Effect.gen(function* () {
      return {
        // No `diff` and no stables: a change of user or group is an update
        // that moves the membership (see `reconcile`), so every attribute
        // may change. A replace would adopt the same membership when the
        // props name the same user another way (`userName` or `userId`, ID
        // or ARN), and its cleanup would then delete it.
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.membershipId && output.identityStoreId) {
            return yield* readMembershipById(output.identityStoreId, output.membershipId);
          }
          if (!olds) {
            return undefined;
          }
          // Memberships carry no ownership metadata. A name/target lookup
          // alone cannot establish that this logical resource created it.
          const identityStoreId = bareIdentifier(yield* resolveIdentityStoreId(olds));
          const userId = yield* resolveUserId(identityStoreId, olds).pipe(
            Effect.catchTag("GroupMembershipUserNotFound", () => Effect.undefined),
          );
          const existing =
            userId === undefined
              ? undefined
              : yield* readMembership(identityStoreId, bareIdentifier(olds.groupId), userId);
          return existing === undefined ? undefined : Unowned(existing);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, output, session }) {
          const identityStoreId = bareIdentifier(
            yield* resolveIdentityStoreId({
              identityStoreId:
                news.identityStoreId ??
                (news.instanceArn === undefined ? output?.identityStoreId : undefined),
              instanceArn: news.instanceArn,
            }),
          );
          const groupId = bareIdentifier(news.groupId);
          const userId = yield* resolveUserId(identityStoreId, news);

          // Observe — only the desired (group, user) pair, as
          // `AccountAssignment` does. The membership `output` records is
          // never reused for another pair.
          let existing = yield* readMembership(identityStoreId, groupId, userId);
          let admittedMembershipId =
            output !== undefined && bareIdentifier(output.identityStoreId) === identityStoreId
              ? bareIdentifier(output.membershipId)
              : undefined;

          // Ensure — a concurrent create answers ConflictException; read it
          // back instead.
          if (!existing) {
            const created = yield* identitystore
              .createGroupMembership({
                IdentityStoreId: identityStoreId,
                GroupId: groupId,
                MemberId: { UserId: userId },
              })
              .pipe(
                Effect.map((response) => response.MembershipId),
                Effect.catchTag("ConflictException", () => Effect.undefined),
                retryIdentityCenter,
              );
            admittedMembershipId = created ?? admittedMembershipId;
            existing = yield* readMembership(identityStoreId, groupId, userId);
            if (!existing) {
              return yield* new GroupMembershipUnexpectedResponse({
                message: `membership of user '${userId}' in group '${groupId}' not found after create`,
              });
            }
          }

          if (existing.membershipId !== admittedMembershipId && !(yield* adoptionAllowed(fqn))) {
            return yield* new OwnedBySomeoneElse({
              message: `Membership '${existing.membershipId}' already exists. Use --adopt or adopt(true) to take it over.`,
              resourceType: GroupMembership.Type,
              logicalId: id,
              physicalName: existing.membershipId,
            });
          }

          // Prune — the props moved the membership to another user or group,
          // so the one `output` records goes. This is an update, not a
          // replace, because a user or group the same deploy creates is
          // unknown when the plan is made. A crash after the delete leaves
          // the resource updating, and the retry finds it already gone.
          if (
            output !== undefined &&
            (bareIdentifier(output.identityStoreId) !== identityStoreId ||
              bareIdentifier(output.membershipId) !== bareIdentifier(existing.membershipId))
          ) {
            yield* deleteMembership(output);
          }

          yield* session.note(existing.membershipId);
          return existing;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteMembership(output);
        }),
      };
    }),
  );

const deleteMembership = (membership: GroupMembership["Attributes"]) =>
  retryIdentityCenter(
    identitystore
      .deleteGroupMembership({
        IdentityStoreId: membership.identityStoreId,
        MembershipId: membership.membershipId,
      })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
  );

const resolveUserId = Effect.fn(function* (identityStoreId: string, member: GroupMembershipProps) {
  if (member.userId !== undefined) return bareIdentifier(member.userId);
  const userName = member.userName;
  const userId = yield* getUserIdByUserName(identityStoreId, userName);
  if (userId === undefined) {
    return yield* new GroupMembershipUserNotFound({
      message: `Identity store '${identityStoreId}' has no user named '${userName}'`,
      userName,
      identityStoreId,
    });
  }
  return userId;
});

const readMembershipById = Effect.fn(function* (identityStoreId: string, membershipId: string) {
  const response = yield* retryIdentityCenter(
    identitystore
      .describeGroupMembership({ IdentityStoreId: identityStoreId, MembershipId: membershipId })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined)),
  );
  if (!response?.MembershipId || !response.MemberId?.UserId) {
    return undefined;
  }
  return {
    identityStoreId: response.IdentityStoreId,
    membershipId: response.MembershipId,
    groupId: response.GroupId,
    userId: response.MemberId.UserId,
  } satisfies GroupMembership["Attributes"];
});

const readMembership = Effect.fn(function* (
  identityStoreId: string,
  groupId: string,
  userId: string,
) {
  const response = yield* retryIdentityCenter(
    identitystore
      .getGroupMembershipId({
        IdentityStoreId: identityStoreId,
        GroupId: groupId,
        MemberId: { UserId: userId },
      })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined)),
  );
  if (!response?.MembershipId) {
    return undefined;
  }
  return {
    identityStoreId: response.IdentityStoreId,
    membershipId: response.MembershipId,
    groupId,
    userId,
  } satisfies GroupMembership["Attributes"];
});
