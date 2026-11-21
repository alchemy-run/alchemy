import * as Usergroups from "@distilled.cloud/slack/usergroups";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface UserGroupProps {
  /**
   * Display name. If omitted, a unique name is generated from the app, stage
   * and logical ID.
   */
  name?: string;
  /**
   * Mention handle, without the `@` (`oncall` → `@oncall`). Lowercase, unique
   * in the workspace. Defaults to the name, lowercased with spaces turned
   * into hyphens.
   */
  handle?: string;
  /** Short description, at most 140 characters. */
  description?: string;
  /**
   * Channel IDs members are added to by default. Omitted leaves the group's
   * default channels as they are.
   */
  channels?: string[];
  /**
   * Member user IDs. Slack requires a user group to have at least one member
   * once it has any, so an empty list is not allowed; omit it to leave
   * membership alone.
   */
  users?: string[];
  /** Workspace to create the group in, for org-level (Enterprise Grid) tokens. */
  teamId?: string;
}

export interface UserGroupAttributes {
  /** User group ID (`S…`). */
  userGroupId: string;
  name: string;
  handle: string;
  description: string;
  /** Default channel IDs. */
  channels: string[];
  /** Member user IDs. */
  users: string[];
  teamId: string;
}

export type UserGroup = Resource<
  "Slack.UserGroup",
  UserGroupProps,
  UserGroupAttributes,
  never,
  Providers
>;

/** No user group was found after create reported the name or handle taken. */
export class UserGroupNotFound extends Data.TaggedError("Slack.UserGroupNotFound")<{
  readonly handle: string;
  readonly message: string;
}> {}

/**
 * A Slack user group: a mentionable handle (`@oncall`) for a set of members,
 * with default channels they join.
 *
 * Slack can't delete user groups, so destroying the resource **disables**
 * it. A disabled group keeps its name and handle; deploying again with the
 * same handle re-enables it.
 *
 * User groups need a paid Slack plan (`paid_teams_only` otherwise) and the
 * bot scopes `usergroups:write` and `usergroups:read`. Some workspaces also
 * restrict who may manage groups (`permission_denied`).
 *
 * ### Creating a User Group
 * **Example:** An on-call group with a default channel
 * ```typescript
 * const oncall = yield* Slack.UserGroup("OnCall", {
 *   name: "On-call",
 *   handle: "oncall",
 *   description: "Whoever holds the pager this week",
 *   channels: [incidents.channelId],
 *   users: ["U0123456789"],
 * });
 * ```
 *
 * @resource
 * @product UserGroup
 */
export const UserGroup = Resource<UserGroup>("Slack.UserGroup");

const handleOf = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

const createGroupName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 80, lowercase: true });

const toAttrs = (group: Usergroups.Usergroup): UserGroupAttributes => ({
  userGroupId: group.id,
  name: group.name ?? "",
  handle: group.handle ?? "",
  description: group.description ?? "",
  channels: [...(group.prefs?.channels ?? [])],
  users: [...(group.users ?? [])],
  teamId: group.team_id ?? "",
});

/** Every group in the workspace, disabled ones included. */
const listGroups = (teamId: string | undefined) =>
  Usergroups.listUsergroups({
    include_disabled: true,
    include_users: true,
    team_id: teamId,
  }).pipe(Effect.map((response) => response.usergroups));

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

export const UserGroupProvider = () =>
  Provider.succeed(UserGroup, {
    stables: ["userGroupId", "teamId"],

    read: Effect.fn(function* ({ id, olds, output }) {
      const groups = yield* listGroups(olds?.teamId);
      if (output?.userGroupId !== undefined) {
        const group = groups.find((g) => g.id === output.userGroupId);
        return group === undefined || (group.date_delete ?? 0) > 0 ? undefined : toAttrs(group);
      }
      // State was lost after a create: look for the handle this resource
      // would claim. Groups carry no ownership marker, so a found group is
      // only adopted with `--adopt`.
      const handle = olds?.handle ?? handleOf(yield* createGroupName(id, olds?.name));
      const group = groups.find((g) => g.handle === handle);
      return group === undefined || (group.date_delete ?? 0) > 0
        ? undefined
        : Unowned(toAttrs(group));
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createGroupName(id, news.name ?? output?.name);
      const handle = news.handle ?? handleOf(name);

      // Observe — there is no get-by-id; the list (disabled included) is the
      // source of truth.
      const groups = yield* listGroups(news.teamId);
      let group =
        (output?.userGroupId !== undefined
          ? groups.find((g) => g.id === output.userGroupId)
          : undefined) ?? groups.find((g) => g.handle === handle);

      // Ensure — create, or tolerate the race where the handle got taken.
      if (group === undefined) {
        group = yield* Usergroups.createUsergroup({
          name,
          handle,
          description: news.description,
          channels: news.channels,
          team_id: news.teamId,
        }).pipe(
          Effect.map((response) => response.usergroup),
          Effect.catchTag(["NameAlreadyExists", "HandleAlreadyExists"], () =>
            listGroups(news.teamId).pipe(
              Effect.map((all) => all.find((g) => g.handle === handle || g.name === name)),
            ),
          ),
        );
      }
      if (group === undefined) {
        return yield* new UserGroupNotFound({
          handle,
          message: `Slack reported user group '${name}' (@${handle}) taken, but no group with that name or handle is visible.`,
        });
      }
      if ((group.date_delete ?? 0) > 0) {
        group = (yield* Usergroups.enableUsergroup({
          usergroup: group.id,
          team_id: news.teamId,
        })).usergroup;
      }

      // Sync — against the observed group.
      const channels = news.channels;
      if (
        group.name !== name ||
        group.handle !== handle ||
        (news.description !== undefined && (group.description ?? "") !== news.description) ||
        (channels !== undefined && !sameSet(group.prefs?.channels ?? [], channels))
      ) {
        group = (yield* Usergroups.updateUsergroup({
          usergroup: group.id,
          name,
          handle,
          description: news.description,
          channels,
          team_id: news.teamId,
        })).usergroup;
      }
      if (news.users !== undefined && !sameSet(group.users ?? [], news.users)) {
        group = (yield* Usergroups.updateUser({
          usergroup: group.id,
          users: news.users,
          team_id: news.teamId,
        })).usergroup;
      }

      const fresh = (yield* listGroups(news.teamId)).find((g) => g.id === group.id);
      return toAttrs(fresh ?? group);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const group = (yield* listGroups(olds?.teamId)).find((g) => g.id === output.userGroupId);
      if (group === undefined || (group.date_delete ?? 0) > 0) return;
      yield* Usergroups.disableUsergroup({ usergroup: output.userGroupId, team_id: olds?.teamId });
    }),
  });
