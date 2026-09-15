import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeEmail,
  expandParent,
  findOwnedUser,
  hasOwnershipMarker,
  listParentsForNuke,
  listUsers,
  ownedByAlchemy,
  ownershipLabels,
  parentOfName,
  replaceOnIdentity,
  resourceName,
  sameText,
  toAttrs,
  toEmail,
  type ClientUserState,
} from "./internal.ts";

export type BuyersClientsUserProps = {
  /**
   * Parent client, as `buyers/{buyer}/clients/{client}` or
   * `{buyer}/clients/{client}`. Immutable — changing it replaces the
   * client user.
   */
  parent: string;
  /**
   * Invitee email. Unique per client. Immutable — changing it replaces
   * the user. If omitted, a unique `example.com` address is generated.
   * Client users have no labels field, so Alchemy stamps ownership into
   * a `+alc.{stack}.{stage}.{id}` plus-tag and strips it from attributes.
   */
  email?: string;
  /**
   * Server-assigned user id (last path segment). Omit on create; pass
   * the observed id to keep the same user. Immutable — changing it
   * replaces the user.
   */
  userId?: string;
  /**
   * Desired serving state after the invite is accepted. Create always
   * yields `INVITED`. `ACTIVE` / `INACTIVE` are applied only once the
   * user has left `INVITED` (`activate` / `deactivate`).
   */
  state?: ClientUserState | (string & {});
};

export type BuyersClientsUser = Resource<
  "GCP.Authorizedbuyersmarketplace.BuyersClientsUser",
  BuyersClientsUserProps,
  {
    /** Full resource name `buyers/{buyer}/clients/{client}/users/{user}`. */
    name: string;
    /** Server-assigned user id (last path segment). */
    userId: string;
    /** Parent client resource name. */
    parent: string;
    /** Project id used when the client user was reconciled. */
    project: string;
    /** Invitee email with the Alchemy plus-tag stripped. */
    email: string;
    /** Server-reported user state (`INVITED`, `ACTIVE`, `INACTIVE`). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Authorized Buyers Marketplace client user
 * (`buyers/{buyer}/clients/{client}/users/{user}`).
 *
 * Client users have no labels or description — Alchemy stamps ownership
 * into the email plus-tag so `list` / nuke can find them. Parent and
 * email are identity; changing either replaces the user. Create sends an
 * invitation (`INVITED`). Activate and deactivate only apply after the
 * invitee accepts.
 *
 * ### Creating a Client User
 * **Example:** Generated email
 * ```typescript
 * const user = yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
 *   "Analyst",
 *   { parent: "buyers/123/clients/456" },
 * );
 * ```
 *
 * **Example:** Invite a known mailbox
 * ```typescript
 * const user = yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
 *   "Analyst",
 *   {
 *     parent: "buyers/123/clients/456",
 *     email: "analyst@example.com",
 *   },
 * );
 * ```
 *
 * ### Updating a Client User
 * **Example:** Deactivate after the invite is accepted
 * ```typescript
 * const user = yield* GCP.Authorizedbuyersmarketplace.BuyersClientsUser(
 *   "Analyst",
 *   {
 *     parent: existing.parent,
 *     userId: existing.userId,
 *     email: "analyst@example.com",
 *     state: "INACTIVE",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Authorizedbuyersmarketplace
 */
export const BuyersClientsUser = Resource<BuyersClientsUser>(
  "GCP.Authorizedbuyersmarketplace.BuyersClientsUser",
);

export class BuyersClientsUserNotResolved extends Data.TaggedError(
  "GCP.Authorizedbuyersmarketplace.BuyersClientsUserNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const getByName = (name: string) =>
  !name
    ? Effect.succeed(undefined)
    : marketplace.getBuyersClientsUsers({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
      );

const lookupName = (
  parent: string,
  userId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  if (userId && userId.length > 0 && parent.length > 0) {
    return resourceName(parent, userId);
  }
  return "";
};

const syncState = (
  current: marketplace.ClientUser,
  desired: string | undefined,
) =>
  Effect.gen(function* () {
    if (!desired || !current.name) return current;
    const observed = current.state ?? "";
    if (sameText(observed, desired)) return current;
    if (observed === "INVITED") return current;
    if (desired === "ACTIVE" && observed === "INACTIVE") {
      return yield* marketplace.activateBuyersClientsUsers({
        name: current.name,
      });
    }
    if (desired === "INACTIVE" && observed === "ACTIVE") {
      return yield* marketplace.deactivateBuyersClientsUsers({
        name: current.name,
      });
    }
    return current;
  });

export const BuyersClientsUserProvider = () =>
  Provider.succeed(BuyersClientsUser, {
    stables: ["name", "userId", "parent", "project", "email"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: expandParent(olds?.parent ?? output?.parent ?? ""),
        nextParent: expandParent(news.parent),
        previousEmail: olds?.email ?? output?.email,
        nextEmail: news.email,
        previousUserId: olds?.userId ?? output?.userId,
        nextUserId: news.userId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandParent(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.userId ?? output?.userId,
        output?.name,
      );
      let existing = yield* getByName(name);
      if (existing === undefined && parent) {
        existing = yield* findOwnedUser(
          yield* listUsers(parent),
          id,
          name,
          olds?.email ?? output?.email,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        parentOfName(existing.name ?? "") || parent,
        env.project,
      );
      return (yield* ownedByAlchemy(id, existing.email))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listParentsForNuke();
        const pages = yield* Effect.forEach(parents, listUsers, {
          concurrency: 4,
        });
        return pages.flatMap((users, index) =>
          users
            .filter((user) => hasOwnershipMarker(user.email))
            .map((user) => toAttrs(user, parents[index] ?? "", env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandParent(news.parent);
      const ownership = yield* ownershipLabels(id);
      const userEmail = yield* toEmail(id, news.email, output?.email);
      const stampedEmail = encodeEmail(ownership, userEmail);
      const name = lookupName(
        parent,
        news.userId ?? output?.userId,
        output?.name,
      );

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findOwnedUser(
          yield* listUsers(parent),
          id,
          name,
          userEmail,
        );
      }

      if (current === undefined) {
        const created = yield* marketplace
          .createBuyersClientsUsers({
            parent,
            body: { email: stampedEmail },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listUsers(parent).pipe(
                Effect.flatMap((users) =>
                  findOwnedUser(users, id, undefined, userEmail),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BuyersClientsUserNotResolved({
          parent,
          name: name || stampedEmail,
        });
      }

      current = yield* syncState(current, news.state);

      return toAttrs(current, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* marketplace
        .deleteBuyersClientsUsers({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
