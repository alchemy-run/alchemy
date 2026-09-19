import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type AssignedUserRoleValue = {
  /** Advertiser this role applies to. */
  advertiserId?: string;
  /** Partner this role applies to. */
  partnerId?: string;
  /**
   * Role, for example `STANDARD`, `READ_ONLY`, or `ADMIN`.
   */
  userRole?: string;
};

export type UserProps = {
  /**
   * System-assigned user id. Omit on create; pass the observed id to
   * update in place.
   */
  userId?: string;
  /**
   * Display name (max 240 bytes). Users have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * Email used to identify the user. Immutable — changing it replaces
   * the user. Required on create.
   */
  email: string;
  /**
   * Roles granted on create. Updates go through a separate bulk-edit API
   * and are not patched in place.
   */
  assignedUserRoles?: AssignedUserRoleValue[];
};

export type User = Resource<
  "GCP.Displayvideo.User",
  UserProps,
  {
    /** Resource name `users/{user}`. */
    name: string;
    /** System-assigned user id. */
    userId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Email address. */
    email: string | undefined;
    /** Assigned user roles. */
    assignedUserRoles: AssignedUserRoleValue[] | undefined;
    /** RFC3339 last-login timestamp. */
    lastLoginTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 user.
 *
 * Users have no labels field — Alchemy stamps ownership into the display
 * name so `list` / nuke can find them. Email is immutable. Display name
 * updates in place. Create and list require the unique user-management
 * OAuth prerequisites.
 *
 * ### Creating a User
 * **Example:** Read-only partner user
 * ```typescript
 * const user = yield* GCP.Displayvideo.User("Analyst", {
 *   email: "analyst@example.com",
 *   displayName: "analyst",
 *   assignedUserRoles: [
 *     { partnerId: "123", userRole: "READ_ONLY" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const User = Resource<User>("GCP.Displayvideo.User");

export class UserNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.UserNotResolved",
)<{
  userId: string;
}> {}

const toAttrs = (user: dv.User) => {
  const parsed = parseOwnership(user.displayName);
  return {
    name: user.name ?? "",
    userId: user.userId ?? "",
    displayName: parsed.text,
    email: user.email,
    assignedUserRoles: user.assignedUserRoles,
    lastLoginTime: user.lastLoginTime,
  };
};

const getById = (userId: string | undefined) =>
  !userId
    ? Effect.succeed(undefined)
    : dv
        .getUsers({ userId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listUsers = (filter?: string) =>
  dv.listUsers.pages({ pageSize: 200, filter }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.users ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.User[]),
  );

const findByEmail = (email: string) =>
  listUsers(`email:"${email}"`).pipe(
    Effect.map((users) => users.find((user) => user.email === email)),
  );

const findByDisplayName = (displayName: string) =>
  listUsers(`displayName:"alchemy"`).pipe(
    Effect.map((users) =>
      users.find((user) => user.displayName === displayName),
    ),
  );

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["name", "userId", "email"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEmail = olds?.email ?? output?.email;
      if (previousEmail !== undefined && news.email !== previousEmail) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.userId ?? output?.userId;
      if (
        previousId !== undefined &&
        news.userId !== undefined &&
        news.userId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      let existing = yield* getById(olds?.userId ?? output?.userId);
      if (existing === undefined && olds?.email) {
        existing = yield* findByEmail(olds.email);
      }
      if (existing === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const users = yield* listUsers('displayName:"alchemy"');
        return users
          .filter((user) => hasOwnershipMarker(user.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const assignedUserRoles = news.assignedUserRoles;

      let current = yield* getById(news.userId ?? output?.userId);
      if (current === undefined) {
        current = yield* findByEmail(news.email);
      }
      if (current === undefined) {
        current = yield* findByDisplayName(displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createUsers({
            body: {
              displayName,
              email: news.email,
              assignedUserRoles,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findByEmail(news.email)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UserNotResolved({
          userId: news.userId ?? output?.userId ?? news.email,
        });
      }

      const userId = current.userId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchUsers({
          userId,
          updateMask: updateMaskOf("displayName"),
          body: {
            userId,
            displayName,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.userId) return;
      yield* dv
        .deleteUsers({ userId: output.userId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
