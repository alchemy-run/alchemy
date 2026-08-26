import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  expandAccount,
  isAlchemyEmail,
  lastSegment,
  listAccountPaths,
  parentOf,
  resourcePath,
  sameJson,
  sameText,
  toGeneratedEmail,
} from "./internal.ts";

export type UserAccountAccess = {
  /**
   * Account permission (`noAccess`, `user`, `admin`).
   * @default "user"
   */
  permission?: string;
};

export type UserContainerAccess = {
  /** GTM container id. */
  containerId?: string;
  /** Container permission (`noAccess`, `read`, `edit`, `approve`, `publish`). */
  permission?: string;
};

export type UserProps = {
  /**
   * Parent GTM account path `accounts/{account}`. Immutable — changing
   * it replaces the user permission.
   */
  account: string;
  /**
   * Server-assigned user permission id. Immutable — changing it replaces
   * the permission.
   */
  userPermissionId?: string;
  /**
   * User email address. Identity for this resource. If omitted, Alchemy
   * generates `alc.{id}@example.com` so `list` / nuke can find it.
   * User permissions have no notes or labels field.
   */
  emailAddress?: string;
  /**
   * Account-level access.
   * @default { permission: "user" }
   */
  accountAccess?: UserAccountAccess;
  /** Per-container access. */
  containerAccess?: UserContainerAccess[];
};

export type User = Resource<
  "GCP.Tagmanager.User",
  UserProps,
  {
    /** GTM API relative path. */
    path: string;
    /** User permission id. */
    userPermissionId: string;
    /** Parent account path. */
    account: string;
    /** Account id. */
    accountId: string | undefined;
    /** Email address. */
    emailAddress: string | undefined;
    /** Account-level access. */
    accountAccess: UserAccountAccess | undefined;
    /** Per-container access. */
    containerAccess: UserContainerAccess[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager user permission on an account.
 *
 * User permissions have no labels or notes field. Alchemy-generated
 * emails use the `alc.` prefix so `list` / nuke can find them. Parent
 * account, permission id, and email are immutable. Account and
 * container access update in place.
 *
 * ### Creating a User Permission
 * **Example:** Grant user access
 * ```typescript
 * const user = yield* GCP.Tagmanager.User("Analyst", {
 *   account: accountPath,
 *   emailAddress: "alc.analyst@example.com",
 *   accountAccess: { permission: "user" },
 * });
 * ```
 *
 * ### Updating a User Permission
 * **Example:** Raise account access
 * ```typescript
 * const user = yield* GCP.Tagmanager.User("Analyst", {
 *   account: existing.account,
 *   userPermissionId: existing.userPermissionId,
 *   emailAddress: existing.emailAddress,
 *   accountAccess: { permission: "admin" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const User = Resource<User>("GCP.Tagmanager.User");

export class UserNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.UserNotResolved",
)<{
  path: string;
}> {}

const COLLECTION = "user_permissions";
const DEFAULT_PERMISSION = "user";

const accountAccessOf = (
  access: tagmanager.AccountAccess | undefined,
): UserAccountAccess | undefined => {
  if (access === undefined) return undefined;
  return { permission: access.permission };
};

const containerAccessOf = (
  list: readonly tagmanager.ContainerAccess[] | undefined,
): UserContainerAccess[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((access) => ({
    containerId: access.containerId,
    permission: access.permission,
  }));
};

const toAttrs = (
  permission: tagmanager.UserPermission,
  accountHint?: string,
) => {
  const path = permission.path ?? "";
  return {
    path,
    userPermissionId: lastSegment(path),
    account: path.includes("/user_permissions/")
      ? parentOf(path)
      : (accountHint ?? expandAccount(path)),
    accountId: permission.accountId,
    emailAddress: permission.emailAddress,
    accountAccess: accountAccessOf(permission.accountAccess),
    containerAccess: containerAccessOf(permission.containerAccess),
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsUser_permissions({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  tagmanager.listAccountsUser_permissions.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.userPermission ?? [])),
    Stream.filter((permission) => isAlchemyEmail(permission.emailAddress)),
    Stream.map((permission) => toAttrs(permission, parent)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByEmail = (parent: string, emailAddress: string) =>
  tagmanager.listAccountsUser_permissions.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.userPermission ?? [])),
    Stream.filter(
      (permission) =>
        (permission.emailAddress ?? "").toLowerCase() ===
        emailAddress.toLowerCase(),
    ),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

const isOwnedPermission = (
  permission: tagmanager.UserPermission,
  outputPath: string | undefined,
) =>
  isAlchemyEmail(permission.emailAddress) ||
  (outputPath !== undefined && permission.path === outputPath);

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: [
      "path",
      "userPermissionId",
      "account",
      "accountId",
      "emailAddress",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAccount = olds?.account ?? output?.account;
      if (
        previousAccount !== undefined &&
        expandAccount(news.account) !== expandAccount(previousAccount)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.userPermissionId ?? output?.userPermissionId;
      if (
        previousId !== undefined &&
        news.userPermissionId !== undefined &&
        news.userPermissionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousEmail = olds?.emailAddress ?? output?.emailAddress;
      if (
        previousEmail !== undefined &&
        news.emailAddress !== undefined &&
        news.emailAddress.toLowerCase() !== previousEmail.toLowerCase()
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const account =
        olds?.account !== undefined
          ? expandAccount(olds.account)
          : output?.account;
      const path =
        output?.path ??
        (account !== undefined &&
        (olds?.userPermissionId ?? output?.userPermissionId) !== undefined
          ? resourcePath(
              account,
              COLLECTION,
              olds?.userPermissionId ?? output?.userPermissionId ?? "",
            )
          : "");
      let existing = yield* getByPath(path);
      if (
        existing === undefined &&
        account !== undefined &&
        (olds?.emailAddress ?? output?.emailAddress) !== undefined
      ) {
        existing = yield* findByEmail(
          account,
          olds?.emailAddress ?? output?.emailAddress ?? "",
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, account);
      return isOwnedPermission(existing, output?.path) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const accounts = yield* listAccountPaths();
        const pages = yield* Effect.forEach(accounts, listAt, {
          concurrency: 4,
        });
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const account = expandAccount(news.account);
      const emailAddress = yield* toGeneratedEmail(id, news.emailAddress);
      const accountAccess = {
        permission: news.accountAccess?.permission ?? DEFAULT_PERMISSION,
      };
      const body: tagmanager.UserPermission = {
        emailAddress,
        accountAccess,
        containerAccess: news.containerAccess,
      };

      const path =
        output?.path ??
        (news.userPermissionId !== undefined
          ? resourcePath(account, COLLECTION, news.userPermissionId)
          : "");

      let current = yield* getByPath(path);
      if (current === undefined) {
        current = yield* findByEmail(account, emailAddress);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsUser_permissions({
            parent: account,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByEmail(account, emailAddress),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UserNotResolved({
          path: path || `${account}/${COLLECTION}`,
        });
      }

      const currentPath = current.path ?? path;
      const observedAccess = accountAccessOf(current.accountAccess);
      const changed =
        !sameText(observedAccess?.permission, accountAccess.permission) ||
        !sameJson(
          containerAccessOf(current.containerAccess),
          news.containerAccess,
        );

      if (changed) {
        current = yield* tagmanager.updateAccountsUser_permissions({
          path: currentPath,
          body: {
            ...body,
            path: currentPath,
            accountId: current.accountId,
            emailAddress: current.emailAddress ?? emailAddress,
          },
        });
      }

      return toAttrs(current, account);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsUser_permissions({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
