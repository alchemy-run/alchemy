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
  getReturnPolicy,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleMerchantIds,
  listReturnPoliciesAt,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  toResourceId,
} from "./internal.ts";

export type ReturnPolicyOnlinePolicy = {
  /** Policy type (`NO_RETURNS`, `NUMBER_OF_DAYS_AFTER_DELIVERY`, …). */
  type?: string;
  /** Days after delivery that returns are accepted. */
  days?: string;
};

export type ReturnPolicyOnlineRestockingFee = {
  /** Percent of total price in micros (15000000 = 15%). */
  microPercent?: number;
  /** Fixed restocking fee. */
  fixedFee?: { value?: string; currency?: string };
};

export type ReturnPolicyOnlineReturnShippingFee = {
  /** Fee type (`FIXED`, `CUSTOMER_PAYING_ACTUAL_FEE`). */
  type?: string;
  /** Fixed fee when type is `FIXED`. */
  fixedFee?: { value?: string; currency?: string };
};

export type ReturnPolicyOnlineReturnReasonCategoryInfo = {
  /** Return reason category (`BUYER_REMORSE`, `ITEM_DEFECT`). */
  returnReasonCategory?: string;
  /** Return label source. */
  returnLabelSource?: string;
  /** Return shipping fee. */
  returnShippingFee?: ReturnPolicyOnlineReturnShippingFee;
};

export type ReturnpolicyonlineProps = {
  /**
   * Merchant Center account that owns the policy. Immutable — changing
   * it replaces the policy.
   */
  merchantId: string;
  /**
   * Google-assigned return policy id. Omit on create. Immutable —
   * changing it replaces the policy.
   */
  returnPolicyId?: string;
  /**
   * Policy name as shown in Merchant Center. Return policies have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  name?: string;
  /**
   * User-defined label unique per country. Policies labeled `default`
   * apply to all products unless a product sets `return_policy_label`.
   */
  label?: string;
  /**
   * Countries of sale (ISO 3166-1 alpha-2).
   */
  countries?: string[];
  /**
   * Return policy.
   */
  policy?: ReturnPolicyOnlinePolicy;
  /**
   * Accepted return methods.
   */
  returnMethods?: string[];
  /**
   * Accepted item conditions.
   */
  itemConditions?: string[];
  /**
   * Return-reason category details.
   */
  returnReasonCategoryInfo?: ReturnPolicyOnlineReturnReasonCategoryInfo[];
  /**
   * Restocking fee.
   */
  restockingFee?: ReturnPolicyOnlineRestockingFee;
  /**
   * Return policy URI.
   */
  returnPolicyUri?: string;
};

export type Returnpolicyonline = Resource<
  "GCP.Content.Returnpolicyonline",
  ReturnpolicyonlineProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** Google-assigned return policy id. */
    returnPolicyId: string;
    /** Policy name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** User-defined label. */
    label: string | undefined;
    /** Countries of sale. */
    countries: string[] | undefined;
    /** Return policy. */
    policy: ReturnPolicyOnlinePolicy | undefined;
    /** Return methods. */
    returnMethods: string[] | undefined;
    /** Item conditions. */
    itemConditions: string[] | undefined;
    /** Return-reason category details. */
    returnReasonCategoryInfo:
      | ReturnPolicyOnlineReturnReasonCategoryInfo[]
      | undefined;
    /** Restocking fee. */
    restockingFee: ReturnPolicyOnlineRestockingFee | undefined;
    /** Return policy URI. */
    returnPolicyUri: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center online return policy for ads and free listings.
 *
 * Return policies have no labels field — Alchemy stamps ownership into
 * `name`. `merchantId` is identity; `returnPolicyId` is assigned on
 * create. Name, label, countries, and policy details update in place.
 *
 * ### Creating a Return Policy
 * **Example:** No returns in the US
 * ```typescript
 * const policy = yield* GCP.Content.Returnpolicyonline("NoReturns", {
 *   merchantId: "123",
 *   name: "no-returns",
 *   label: "default",
 *   countries: ["US"],
 *   policy: { type: "NO_RETURNS" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Returnpolicyonline = Resource<Returnpolicyonline>(
  "GCP.Content.Returnpolicyonline",
);

export class ReturnpolicyonlineNotResolved extends Data.TaggedError(
  "GCP.Content.ReturnpolicyonlineNotResolved",
)<{
  returnPolicyId: string;
}> {}

const toAttrs = (policy: content.ReturnPolicyOnline, merchantId: string) => {
  const parsed = parseOwnership(policy.name);
  return {
    merchantId,
    returnPolicyId: policy.returnPolicyId ?? "",
    name: parsed.text,
    label: policy.label,
    countries: policy.countries,
    policy: policy.policy,
    returnMethods: policy.returnMethods,
    itemConditions: policy.itemConditions,
    returnReasonCategoryInfo: policy.returnReasonCategoryInfo,
    restockingFee: policy.restockingFee,
    returnPolicyUri: policy.returnPolicyUri,
  };
};

export const ReturnpolicyonlineProvider = () =>
  Provider.succeed(Returnpolicyonline, {
    stables: ["merchantId", "returnPolicyId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.returnPolicyId ?? output?.returnPolicyId;
      if (
        previousId !== undefined &&
        news.returnPolicyId !== undefined &&
        news.returnPolicyId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      let existing = yield* getReturnPolicy(
        merchantId,
        olds?.returnPolicyId ?? output?.returnPolicyId ?? "",
      );
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(ownership, olds?.name);
        const listed = yield* listReturnPoliciesAt(merchantId);
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
        const merchantIds = yield* listAccessibleMerchantIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listReturnPoliciesAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const policy of pages[i] ?? []) {
            if (!hasOwnershipMarker(policy.name)) continue;
            attrs.push(toAttrs(policy, merchantId));
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
      const label =
        news.label ?? (yield* toResourceId(id, undefined, output?.label, 20));
      const policy = news.policy ?? { type: "NO_RETURNS" };
      const countries = news.countries ?? ["US"];
      const body: content.ReturnPolicyOnline = {
        name,
        label,
        countries,
        policy,
        returnMethods: news.returnMethods,
        itemConditions: news.itemConditions,
        returnReasonCategoryInfo: news.returnReasonCategoryInfo,
        restockingFee: news.restockingFee,
        returnPolicyUri: news.returnPolicyUri,
      };

      let current = yield* getReturnPolicy(
        merchantId,
        news.returnPolicyId ?? output?.returnPolicyId ?? "",
      );
      if (current === undefined) {
        const listed = yield* listReturnPoliciesAt(merchantId);
        current = listed.find((item) => item.name === name);
      }

      if (current === undefined) {
        const created = yield* content
          .createReturnpolicyonline({ merchantId, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listReturnPoliciesAt(merchantId).pipe(
                Effect.map((items) => items.find((item) => item.name === name)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReturnpolicyonlineNotResolved({
          returnPolicyId: news.returnPolicyId ?? output?.returnPolicyId ?? "",
        });
      }

      const returnPolicyId = current.returnPolicyId ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.label, label) ||
        !jsonEqual(current.countries, countries) ||
        !jsonEqual(current.policy, policy) ||
        !jsonEqual(current.returnMethods, news.returnMethods) ||
        !jsonEqual(current.itemConditions, news.itemConditions) ||
        !jsonEqual(
          current.returnReasonCategoryInfo,
          news.returnReasonCategoryInfo,
        ) ||
        !jsonEqual(current.restockingFee, news.restockingFee) ||
        !sameText(current.returnPolicyUri, news.returnPolicyUri);

      if (changed) {
        current = yield* content.patchReturnpolicyonline({
          merchantId,
          returnPolicyId,
          body: { ...body, returnPolicyId },
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.returnPolicyId) return;
      yield* content
        .deleteReturnpolicyonline({
          merchantId: output.merchantId,
          returnPolicyId: output.returnPolicyId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
