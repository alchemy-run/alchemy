import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  CreateTaxIds,
  DeleteTaxIds,
  GetTaxIds,
  GetTaxIdsById,
  type TaxId as StripeTaxId,
  type TaxIdType,
  type TaxIdVerificationStatus,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { isMissingStripeResource } from "./missing.ts";
import type { Providers } from "./Providers.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** Who a tax id belongs to: this account, a connected account, or the platform's application. */
export type TaxIdOwner =
  | { type: "self" }
  | { type: "account"; account: string }
  | { type: "application" };

export interface TaxIdProps {
  /**
   * Tax id type, e.g. `eu_vat`, `gb_vat`, `us_ein`, `au_abn`.
   * Create-only — changing it replaces the tax id.
   */
  type: Exclude<TaxIdType, "unknown">;
  /**
   * The tax id value, e.g. `"DE123456789"`. Create-only — changing it
   * replaces the tax id.
   */
  value: string;
  /**
   * Who the tax id belongs to. Customers' tax ids are
   * {@link CustomerTaxId}. Create-only — changing it replaces the tax id.
   * @default { type: "self" }
   */
  owner?: TaxIdOwner;
}

export type TaxId = Resource<
  "Stripe.TaxId",
  TaxIdProps,
  {
    /** Stripe tax id id (`txi_…`). */
    id: string;
    /** Tax id type. */
    type: TaxIdType;
    /** The tax id value. */
    value: string;
    /** Who the tax id belongs to. */
    owner: TaxIdOwner;
    /** Two-letter country code the tax id is for, if known. */
    country: string | undefined;
    /** Verification status (`pending`, `verified`, `unverified`, `unavailable`), if verified. */
    verificationStatus: TaxIdVerificationStatus | undefined;
    /** Unix timestamp when the tax id was created. */
    created: number;
    /** Whether the tax id exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  TaxIdLookup
>;

/** Props for {@link TaxId.lookup}: find a tax id this stack doesn't manage by its id. */
export interface TaxIdLookup {
  /** Stripe tax id id, e.g. `"txi_1A2b3C4d5E6f7G8h"`. */
  id: string;
}

/**
 * A tax id of your business (or a connected account) — the VAT, GST, or EIN
 * number Stripe shows on invoices, receipts, and Checkout. For a customer's
 * tax id, use {@link CustomerTaxId}.
 *
 * Tax ids are immutable: changing any prop replaces it. They carry no
 * metadata, so a tax id this stack didn't create (matched by type and
 * value) is only adopted with `--adopt`.
 *
 * @see https://docs.stripe.com/api/tax_ids
 *
 * ### Creating a tax id
 * **Example:** Your EU VAT number
 * ```typescript
 * const vat = yield* Stripe.TaxId("vat", {
 *   type: "eu_vat",
 *   value: "DE123456789",
 * });
 * ```
 *
 * **Example:** A connected account's tax id
 * ```typescript
 * const taxId = yield* Stripe.TaxId("seller-vat", {
 *   type: "gb_vat",
 *   value: "GB123456789",
 *   owner: { type: "account", account: seller.id },
 * });
 * ```
 *
 * ### Looking up an existing tax id
 * `TaxId.lookup` references a tax id Alchemy doesn't manage. It is read
 * during plan/deploy, never created, updated or deleted.
 *
 * **Example:** Reference an existing tax id
 * ```typescript
 * const ref = Stripe.TaxId.lookup({ id: "txi_1A2b3C4d5E6f7G8h" });
 * ```
 *
 * @resource
 * @product Tax
 */
export const TaxId = Resource<TaxId>("Stripe.TaxId");

type TaxIdAttributes = TaxId["Attributes"];

const idOf = (value: string | { readonly id: string } | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? value : value.id;

const ownerOf = (taxId: StripeTaxId): TaxIdOwner => {
  const owner = taxId.owner;
  if (owner?.type === "account") return { type: "account", account: idOf(owner.account) ?? "" };
  if (owner?.type === "application") return { type: "application" };
  return { type: "self" };
};

const toAttrs = (taxId: StripeTaxId): TaxIdAttributes => ({
  id: taxId.id,
  type: taxId.type,
  value: taxId.value,
  owner: ownerOf(taxId),
  country: taxId.country ?? undefined,
  verificationStatus: taxId.verification?.status,
  created: taxId.created,
  livemode: taxId.livemode,
});

const ownerEqual = (desired: TaxIdOwner | undefined, observed: TaxIdOwner) => {
  const want = desired ?? { type: "self" };
  if (want.type !== observed.type) return false;
  return (
    want.type !== "account" || observed.type !== "account" || want.account === observed.account
  );
};

const toWireOwner = (owner: TaxIdOwner) =>
  owner.type === "account" ? { type: owner.type, account: owner.account } : { type: owner.type };

const getById = (id: string) =>
  GetTaxIdsById({ id }).pipe(Effect.catchIf(isMissingStripeResource, () => Effect.undefined));

const findByTypeValue = Effect.fn(function* (news: TaxIdProps) {
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetTaxIds({
      limit: LIST_PAGE_SIZE,
      owner: toWireOwner(news.owner ?? { type: "self" }),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    const match = response.data.find(
      (taxId) => taxId.type === news.type && taxId.value === news.value,
    );
    if (match !== undefined) return match;
    if (!response.has_more || response.data.length === 0) return undefined;
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) return undefined;
  }
  return undefined;
});

const shouldReplace = (news: TaxIdProps, output: TaxIdAttributes | undefined): boolean =>
  output !== undefined &&
  (news.type !== output.type ||
    news.value !== output.value ||
    !ownerEqual(news.owner, output.owner));

export const TaxIdProvider = () =>
  Provider.succeed(TaxId, {
    stables: ["id", "type", "value", "owner", "country", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      return shouldReplace(news, output) ? ({ action: "replace" } as const) : undefined;
    }),

    lookup: Effect.fn(function* ({ id }) {
      const existing = yield* getById(id);
      return existing === undefined ? undefined : toAttrs(existing);
    }),

    read: Effect.fn(function* ({ output, olds }) {
      if (output !== undefined) {
        const byId = yield* getById(output.id);
        if (byId !== undefined) return toAttrs(byId);
      }
      if (olds === undefined) return undefined;
      // No metadata: a tax id matched by value can't be proven ours.
      const found = yield* findByTypeValue(olds);
      return found === undefined ? undefined : Unowned(toAttrs(found));
    }),

    // Tax ids carry no ownership marker, so nuke never enumerates them.
    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      let current = output !== undefined ? yield* getById(output.id) : undefined;
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }
      current ??= yield* findByTypeValue(news);
      if (current === undefined) {
        current = yield* CreateTaxIds({
          type: news.type,
          value: news.value,
          ...(news.owner !== undefined ? { owner: toWireOwner(news.owner) } : {}),
        }).pipe(withRequestOptions({ idempotencyKey: `alchemy-tax-id-${instanceId}` }));
      }
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteTaxIds({ id: output.id }).pipe(
        Effect.catchIf(isMissingStripeResource, () => Effect.void),
      );
    }),
  });
