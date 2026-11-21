import * as identitystore from "@distilled.cloud/aws/identitystore";
import { OwnedBySomeoneElse, unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
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
  unredact,
} from "./common.ts";

export class UserUnexpectedResponse extends Data.TaggedError("UserUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A user's name parts, as the identity store records them. */
export interface UserName {
  /** The full name, formatted for display. */
  formatted?: string;
  /** The given name. */
  givenName?: string;
  /** The family name. */
  familyName?: string;
  /** The middle name. */
  middleName?: string;
  /** An honorific preceding the name. */
  honorificPrefix?: string;
  /** An honorific following the name. */
  honorificSuffix?: string;
}

/**
 * A user's name parts, as a stack declares them. Identity Center requires a
 * given and a family name.
 */
export interface UserNameProps extends UserName {
  /** The required given name. */
  givenName: string;
  /** The required family name. */
  familyName: string;
}

/** A user's email address. */
export interface UserEmail {
  /** The email address. */
  value: string;
  /** e.g. `"work"`. */
  type?: string;
  /** Whether this is the user's primary address. */
  primary?: boolean;
}

export interface UserProps {
  /**
   * Explicit identity store ID or ARN.
   * If omitted, Alchemy resolves it from the selected Identity Center instance.
   *
   * The store the user lives in identifies it: naming another store replaces
   * the user (a new user there, then the old one deleted). Naming the same
   * store by ID or by ARN keeps it.
   */
  identityStoreId?: string;
  /**
   * Optional instance ARN used to discover the identity store ID when the
   * user is created. Changing it alone leaves the user in its store.
   */
  instanceArn?: string;
  /**
   * The user's unique name in the identity store, usually an email address.
   * Users sign in with it.
   */
  userName: string;
  /**
   * The name shown for the user. Identity Center requires one.
   */
  displayName: string;
  /**
   * The user's name parts. Identity Center requires `givenName` and
   * `familyName`. Removing an optional part from the props leaves the value
   * the identity store already has.
   */
  name: UserNameProps;
  /**
   * The user's email address. Identity Center takes exactly one.
   */
  emails?: [UserEmail];
}

export interface User extends Resource<
  "AWS.IdentityCenter.User",
  UserProps,
  {
    /** The identity store containing the user. */
    identityStoreId: string;
    /** The unique ID of the user. */
    userId: string;
    /** The user's unique name in the identity store. */
    userName: string;
    /** The name shown for the user. */
    displayName: string | undefined;
    /** The user's name parts. */
    name: UserName | undefined;
    /** The user's email addresses. */
    emails: UserEmail[] | undefined;
  },
  never,
  Providers
> {}

/**
 * A user in the IAM Identity Center identity store, for an instance whose
 * identity source is Identity Center's own directory (users that SCIM or
 * Active Directory sync don't bring in).
 *
 * Users created through the API have no password. If an email address was
 * supplied when the user was created and 'Send email OTP' is enabled, AWS sends
 * a verification email after the first sign-in attempt so the user can set a
 * password. Otherwise, an administrator must generate and share a one-time
 * password.
 *
 * Identity Store users carry no tags, so an existing user with the same
 * `userName` is taken over only with explicit adoption (`--adopt` or
 * `adopt(true)`): when the user is created, when it moves to another identity
 * store, and when the user this resource created is gone and another one has
 * its name.
 *
 * If creation succeeds before its ID is saved, Alchemy cannot distinguish the
 * tagless user from a pre-existing user. Inspect it and rerun with `--adopt`
 * or `adopt(true)`.
 * ### Creating Users
 * **Example:** A Person In The Directory
 * ```typescript
 * const alice = yield* User("Alice", {
 *   identityStoreId: idc.identityStoreId,
 *   userName: "alice@example.com",
 *   displayName: "Alice Example",
 *   name: { givenName: "Alice", familyName: "Example" },
 *   emails: [{ value: "alice@example.com", primary: true }],
 * });
 * ```
 *
 * @resource
 */
export const User = Resource<User>("AWS.IdentityCenter.User");

export const UserProvider = () =>
  Provider.effect(
    User,
    Effect.gen(function* () {
      return {
        // Reconciliation can recreate a missing user, changing its ID even
        // when the store stays the same. Dependents need the resulting ID.
        stables: ["identityStoreId"],
        diff: Effect.fn(function* ({ news, output }) {
          // The store decides, whatever the other props are. Without one in
          // the props, the user stays in the store it lives in, so the
          // engine's own comparison applies.
          if (output === undefined || !("identityStoreId" in news)) return;
          const identityStoreId = news.identityStoreId;
          if (identityStoreId === undefined) return;
          if (!isResolved(identityStoreId)) {
            // The store is known only when the deploy runs; `reconcile`
            // moves the user if it differs, so its store and ID may change.
            return { action: "update", stables: [] } as const;
          }
          // Replace only when the props name another identity store than the
          // one the user lives in. Naming the same store explicitly, by ID
          // or ARN, or changing `instanceArn`, keeps the user: a replacement
          // would find the same user by name and the cleanup would then
          // delete it.
          if (bareIdentifier(identityStoreId) !== bareIdentifier(output.identityStoreId)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output, previous }) {
          if (output?.userId && output.identityStoreId) {
            return yield* readUserById(output.identityStoreId, output.userId);
          }

          if (!olds) {
            return undefined;
          }

          // Identity Store users carry no ownership tags, and `DeleteUser`
          // can't be undone, so a user found by name is taken over only with
          // `--adopt`.
          const identityStoreId = bareIdentifier(yield* resolveIdentityStoreId(olds));
          const existing = yield* readUserByUserName(identityStoreId, olds.userName);
          return existing === undefined
            ? undefined
            : unownedUnlessPrevious(existing, previous, "userId");
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, output, session }) {
          const identityStoreId = bareIdentifier(
            yield* resolveIdentityStoreId({
              identityStoreId: news.identityStoreId ?? output?.identityStoreId,
              instanceArn: news.instanceArn,
            }),
          );
          // `diff` replaces the user when its store changes, but a store the
          // same deploy creates is unknown when the plan is made; then this
          // update moves the user, as a replace would.
          const movedFrom =
            output !== undefined && bareIdentifier(output.identityStoreId) !== identityStoreId
              ? output
              : undefined;

          // Observe — by id when we have one in this store (a user deleted
          // out of band shows up as missing), then by userName.
          let admittedUserId = movedFrom === undefined ? output?.userId : undefined;
          let existing = admittedUserId
            ? yield* readUserById(identityStoreId, admittedUserId)
            : undefined;
          if (!existing) {
            existing = yield* readUserByUserName(identityStoreId, news.userName);
          }

          // Ensure — create the user if missing. A concurrent create of the
          // same userName answers ConflictException; read it back instead.
          if (!existing) {
            const created = yield* identitystore
              .createUser({
                IdentityStoreId: identityStoreId,
                UserName: news.userName,
                DisplayName: news.displayName,
                Name: toWireName(news.name),
                Emails: news.emails?.map(toWireEmail),
              })
              .pipe(
                Effect.map((response) => response.UserId),
                Effect.catchTag("ConflictException", () => Effect.undefined),
                retryIdentityCenter,
              );
            admittedUserId = created ?? admittedUserId;
            existing =
              (created ? yield* readUserById(identityStoreId, created) : undefined) ??
              (yield* readUserByUserName(identityStoreId, news.userName));
            if (!existing) {
              return yield* new UserUnexpectedResponse({
                message: `user '${news.userName}' not found after create`,
              });
            }
          }

          // An empty `output` means no user was admitted. A user discovered
          // after planning, including after a `CreateUser` conflict, requires
          // explicit adoption unless its ID is the result of this
          // reconciliation's successful create.
          if (
            (admittedUserId === undefined ||
              bareIdentifier(existing.userId) !== bareIdentifier(admittedUserId)) &&
            !(yield* adoptionAllowed(fqn))
          ) {
            return yield* new OwnedBySomeoneElse({
              message: `Cannot adopt user '${news.userName}' (${existing.userId}) in identity store '${identityStoreId}': this resource did not create it. Re-run with \`--adopt\` (or wrap the effect in \`adopt(true)\`) to take it over.`,
              resourceType: User.Type,
              logicalId: id,
              physicalName: news.userName,
            });
          }

          // Sync — diff observed attributes against desired and send only
          // the changed ones in one `UpdateUser` call.
          const operations = userOperations(existing, news);
          if (operations.length > 0) {
            yield* retryIdentityCenter(
              identitystore.updateUser({
                IdentityStoreId: existing.identityStoreId,
                UserId: existing.userId,
                Operations: operations,
              }),
            );
            const updated = yield* readUserById(existing.identityStoreId, existing.userId);
            if (!updated) {
              return yield* new UserUnexpectedResponse({
                message: `user '${existing.userId}' not found after update`,
              });
            }
            existing = updated;
          }

          // Prune — a moved user leaves the store `output` records. A crash
          // after the delete leaves the resource updating, and the retry
          // finds it already gone. A crash after `CreateUser` in the new store
          // and before this delete can't tell the new user from someone
          // else's, so its retry needs `--adopt`.
          if (movedFrom !== undefined) {
            yield* deleteUser(movedFrom);
          }

          yield* session.note(existing.userId);
          return existing;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteUser(output);
        }),
      };
    }),
  );

const deleteUser = (user: User["Attributes"]) =>
  retryIdentityCenter(
    identitystore
      .deleteUser({
        IdentityStoreId: user.identityStoreId,
        UserId: user.userId,
      })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
  );

const nameFields = [
  ["formatted", "Formatted"],
  ["givenName", "GivenName"],
  ["familyName", "FamilyName"],
  ["middleName", "MiddleName"],
  ["honorificPrefix", "HonorificPrefix"],
  ["honorificSuffix", "HonorificSuffix"],
] as const;

const toWireName = (name: UserName): identitystore.Name =>
  Object.fromEntries(
    nameFields.flatMap(([field, wire]) => (name[field] === undefined ? [] : [[wire, name[field]]])),
  );

const fromWireName = (name: identitystore.Name | undefined): UserName | undefined => {
  if (name === undefined) return undefined;
  const parts: UserName = Object.fromEntries(
    nameFields.flatMap(([field, wire]) => {
      const value = unredact(name[wire]);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  return Object.keys(parts).length === 0 ? undefined : parts;
};

const toWireEmail = (email: UserEmail): identitystore.Email => ({
  Value: email.value,
  Type: email.type,
  Primary: email.primary,
});

const fromWireEmails = (emails: identitystore.Email[] | undefined): UserEmail[] | undefined => {
  const values = (emails ?? []).flatMap((email): UserEmail[] => {
    const value = unredact(email.Value);
    if (value === undefined) return [];
    const type = unredact(email.Type);
    return [
      {
        value,
        ...(type === undefined ? {} : { type }),
        ...(email.Primary === undefined ? {} : { primary: email.Primary }),
      },
    ];
  });
  return values.length === 0 ? undefined : values;
};

/** Emails in the identity store's SCIM attribute shape, for `UpdateUser`. */
const toAttributeEmails = (emails: UserEmail[]) =>
  emails.map((email) => ({
    value: email.value,
    ...(email.type === undefined ? {} : { type: email.type }),
    ...(email.primary === undefined ? {} : { primary: email.primary }),
  }));

const sameEmails = (a: UserEmail[] | undefined, b: UserEmail[] | undefined) =>
  JSON.stringify(a === undefined ? [] : toAttributeEmails(a)) ===
  JSON.stringify(b === undefined ? [] : toAttributeEmails(b));

/**
 * The `UpdateUser` operations that turn the observed user into the desired
 * one. Attribute paths are SCIM-style (`displayName`, `name.givenName`,
 * `emails`). Only `emails` is ever removed (an operation without a value):
 * Identity Center requires a display name and a name, and an optional name
 * part missing from the props is left as it is.
 */
const userOperations = (
  observed: Pick<User["Attributes"], "userName" | "displayName" | "name" | "emails">,
  desired: Pick<UserProps, "userName" | "displayName" | "name" | "emails">,
): identitystore.AttributeOperation[] => {
  const operations: identitystore.AttributeOperation[] = [];
  if (observed.userName !== desired.userName) {
    operations.push({ AttributePath: "userName", AttributeValue: desired.userName });
  }
  if (observed.displayName !== desired.displayName) {
    operations.push({ AttributePath: "displayName", AttributeValue: desired.displayName });
  }
  for (const [field] of nameFields) {
    const want = desired.name[field];
    if (want !== undefined && observed.name?.[field] !== want) {
      operations.push({ AttributePath: `name.${field}`, AttributeValue: want });
    }
  }
  if (!sameEmails(observed.emails, desired.emails)) {
    operations.push(
      desired.emails === undefined
        ? { AttributePath: "emails" }
        : { AttributePath: "emails", AttributeValue: toAttributeEmails(desired.emails) },
    );
  }
  return operations;
};

const readUserById = Effect.fn(function* (identityStoreId: string, userId: string) {
  const response = yield* retryIdentityCenter(
    identitystore
      .describeUser({ IdentityStoreId: identityStoreId, UserId: userId })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined)),
  );
  const userName = unredact(response?.UserName);
  if (!response?.UserId || userName === undefined) {
    return undefined;
  }
  return {
    identityStoreId: response.IdentityStoreId,
    userId: response.UserId,
    // Sensitive-trait fields decode to Redacted at runtime — unwrap before
    // persisting into Attributes / diffing against desired props.
    userName,
    displayName: unredact(response.DisplayName),
    name: fromWireName(response.Name),
    emails: fromWireEmails(response.Emails),
  } satisfies User["Attributes"];
});

const readUserByUserName = Effect.fn(function* (identityStoreId: string, userName: string) {
  const userId = yield* getUserIdByUserName(identityStoreId, userName);
  return userId ? yield* readUserById(identityStoreId, userId) : undefined;
});
