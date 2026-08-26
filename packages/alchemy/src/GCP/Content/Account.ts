import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  getAccount,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleAggregatorIds,
  listAccountsAt,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
} from "./internal.ts";

export type AccountUser = {
  /** User email. */
  emailAddress?: string;
  /** Whether the user is an admin. */
  admin?: boolean;
  /** Whether the user is a reporting manager. */
  reportingManager?: boolean;
  /** Whether the user has standard read-only access. */
  readOnly?: boolean;
};

export type AccountProps = {
  /**
   * Managing multi-client account id. `insertAccounts` requires an MCA.
   * Immutable — changing it replaces the sub-account.
   */
  merchantId: string;
  /**
   * Sub-account id. Assigned on create. Immutable — changing it
   * replaces the account.
   */
  accountId?: string;
  /**
   * Display name. Accounts have no labels field, so Alchemy ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
  /**
   * Merchant website URL.
   */
  websiteUrl?: string;
  /**
   * Whether the merchant sells adult content.
   * @default false
   */
  adultContent?: boolean;
  /**
   * Client-specific seller id for the child account.
   */
  sellerId?: string;
  /**
   * Users with access to the account.
   */
  users?: AccountUser[];
};

export type Account = Resource<
  "GCP.Content.Account",
  AccountProps,
  {
    /** Managing MCA id. */
    merchantId: string;
    /** Sub-account id. */
    accountId: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Website URL. */
    websiteUrl: string | undefined;
    /** Whether adult content is sold. */
    adultContent: boolean;
    /** Seller id. */
    sellerId: string | undefined;
    /** Users. */
    users: AccountUser[] | undefined;
    /** How the account is managed (`manual` or `automatic`). */
    accountManagement: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center sub-account of a multi-client account.
 *
 * Accounts have no labels field — Alchemy stamps ownership into `name`.
 * `merchantId` (the MCA) is identity. Display name, website, adult-content
 * flag, seller id, and users update in place via a full-document PUT.
 *
 * ### Creating a Sub-account
 * **Example:** Named child account
 * ```typescript
 * const account = yield* GCP.Content.Account("Store", {
 *   merchantId: "123",
 *   name: "downtown-store",
 *   websiteUrl: "https://example.com",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Account = Resource<Account>("GCP.Content.Account");

export class AccountNotResolved extends Data.TaggedError(
  "GCP.Content.AccountNotResolved",
)<{
  merchantId: string;
  accountId: string;
}> {}

const toAttrs = (account: content.Account, merchantId: string) => {
  const parsed = parseOwnership(account.name);
  return {
    merchantId,
    accountId: account.id ?? "",
    name: parsed.text,
    websiteUrl: account.websiteUrl,
    adultContent: account.adultContent === true,
    sellerId: account.sellerId,
    users: account.users,
    accountManagement: account.accountManagement,
  };
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["merchantId", "accountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.accountId ?? output?.accountId;
      if (
        previousId !== undefined &&
        news.accountId !== undefined &&
        news.accountId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      let existing = yield* getAccount(
        merchantId,
        olds?.accountId ?? output?.accountId ?? "",
      );
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(ownership, olds?.name);
        const listed = yield* listAccountsAt(merchantId);
        existing = listed.find((item) => item.name === wanted);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleAggregatorIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listAccountsAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const account of pages[i] ?? []) {
            if (!hasOwnershipMarker(account.name)) continue;
            attrs.push(toAttrs(account, merchantId));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );
      const name = encodeOwnershipLine(ownership, userName);
      const adultContent = news.adultContent === true;
      const body: content.Account = {
        name,
        websiteUrl: news.websiteUrl,
        adultContent,
        sellerId: news.sellerId,
        users: news.users,
      };

      let current = yield* getAccount(
        merchantId,
        news.accountId ?? output?.accountId ?? "",
      );
      if (current === undefined) {
        const listed = yield* listAccountsAt(merchantId);
        current = listed.find((item) => item.name === name);
      }

      if (current === undefined) {
        const created = yield* content
          .insertAccounts({ merchantId, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listAccountsAt(merchantId).pipe(
                Effect.map((items) => items.find((item) => item.name === name)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AccountNotResolved({
          merchantId,
          accountId: news.accountId ?? output?.accountId ?? "",
        });
      }

      const accountId = current.id ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.websiteUrl, news.websiteUrl) ||
        (current.adultContent === true) !== adultContent ||
        !sameText(current.sellerId, news.sellerId) ||
        !jsonEqual(current.users, news.users);

      if (changed) {
        current = yield* content.updateAccounts({
          merchantId,
          accountId,
          body: { ...body, id: accountId },
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.accountId) return;
      yield* content
        .deleteAccounts({
          merchantId: output.merchantId,
          accountId: output.accountId,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
