import * as reseller from "@distilled.cloud/gcp/reseller_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CustomerIdRequired,
  DEFAULT_DELETION_TYPE,
  DEFAULT_PLAN_NAME,
  encodePurchaseOrderId,
  findBySku,
  findOwnedBySku,
  findOwnedSubscription,
  getSubscription,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedSubscriptions,
  ownedByAlchemy,
  ownershipLabels,
  planNamesEqual,
  replaceOnIdentity,
  retryConflict,
  seatsEqual,
  seatsForPlan,
  SkuIdRequired,
  SubscriptionNotResolved,
  toAttrs,
  toCustomerId,
  toSubscriptionId,
} from "./internal.ts";

export { CustomerIdRequired, SkuIdRequired, SubscriptionNotResolved };

export type Seats = {
  /** Maximum assignable licenses on an annual commitment plan. */
  numberOfSeats?: number;
  /** Maximum licensed users on a flexible or trial plan. */
  maximumNumberOfSeats?: number;
  /** Read-only count of users currently assigned a license. */
  licensedNumberOfSeats?: number;
};

export type SubscriptionPlanCommitmentInterval = {
  /** Interval start, milliseconds since Unix epoch. */
  startTime?: string;
  /** Interval end, milliseconds since Unix epoch. */
  endTime?: string;
};

export type SubscriptionProps = {
  /**
   * Customer primary domain or Google-issued customer id (`C` followed
   * by digits). Immutable — changing it replaces the subscription.
   */
  customerId: string;
  /**
   * Product SKU id (for example `Google-Apps` or `1010020027`).
   * Immutable — changing it replaces the subscription.
   */
  skuId: string;
  /**
   * Server-assigned subscription id. Unique per customer and may change
   * when the plan is updated. Omit on create.
   */
  subscriptionId?: string;
  /**
   * Payment plan: `FLEXIBLE`, `TRIAL`, `ANNUAL_MONTHLY_PAY` (returned
   * as `ANNUAL`), `ANNUAL_YEARLY_PAY`, or `FREE`.
   * @default "FLEXIBLE"
   */
  planName?: string;
  /**
   * Seat licenses. Annual plans use `numberOfSeats`; flexible and trial
   * plans use `maximumNumberOfSeats`.
   */
  seats?: Seats;
  /**
   * Reseller purchase-order id (max 80 characters). Subscriptions have
   * no labels field, so Alchemy stamps ownership into a `[alchemy …]`
   * prefix and strips it from attributes.
   */
  purchaseOrderId?: string;
  /**
   * Annual-plan renewal type (`AUTO_RENEW_MONTHLY_PAY`, `CANCEL`, …).
   */
  renewalType?: string;
  /**
   * Google-issued deal code for discounted pricing.
   */
  dealCode?: string;
  /**
   * Hex customer-auth token used when inserting a transferred
   * subscription.
   */
  customerAuthToken?: string;
  /**
   * Insert action (`buy` or `switch`). Use `switch` with `sourceSkuId`
   * when the customer already has another SKU in the same product.
   */
  action?: reseller.InsertSubscriptionsActionEnum | (string & {});
  /**
   * Existing SKU to upgrade or downgrade when `action` is `switch`.
   */
  sourceSkuId?: string;
  /**
   * When true, suspend an active subscription. When false, activate a
   * reseller-initiated suspension. Omitted leaves status unchanged.
   */
  suspended?: boolean;
  /**
   * Immediately move a trial that already has a payment plan onto paid
   * service.
   */
  startPaidService?: boolean;
  /**
   * How destroy cancels the subscription (`cancel` or
   * `transfer_to_direct`).
   * @default "cancel"
   */
  deletionType?: reseller.DeleteSubscriptionsDeletionTypeEnum | (string & {});
};

export type Subscription = Resource<
  "GCP.Reseller.Subscription",
  SubscriptionProps,
  {
    /** Synthetic name `customers/{customerId}/subscriptions/{subscriptionId}`. */
    name: string;
    /** Google-issued customer id (or the domain used on create). */
    customerId: string;
    /** Server-assigned subscription id. */
    subscriptionId: string;
    /** Project id used when the subscription was reconciled. */
    project: string;
    /** Product SKU id. */
    skuId: string | undefined;
    /** Read-only SKU display name. */
    skuName: string | undefined;
    /** Payment plan name as returned by the API. */
    planName: string | undefined;
    /** Whether the plan is an annual commitment. */
    isCommitmentPlan: boolean | undefined;
    /** Annual commitment interval. */
    commitmentInterval: SubscriptionPlanCommitmentInterval | undefined;
    /** Seat licenses. */
    seats: Seats | undefined;
    /** User purchase-order id with the Alchemy ownership prefix stripped. */
    purchaseOrderId: string | undefined;
    /** Annual-plan renewal type. */
    renewalType: string | undefined;
    /** Deal code. */
    dealCode: string | undefined;
    /** Subscription status (`ACTIVE`, `SUSPENDED`, …). */
    status: string | undefined;
    /** True when `status` is `SUSPENDED`. */
    suspended: boolean;
    /** Billing method. */
    billingMethod: string | undefined;
    /** Primary domain of the customer. */
    customerDomain: string | undefined;
    /** Creation time in milliseconds since Unix epoch. */
    creationTime: string | undefined;
    /** Trial end time in milliseconds since Unix epoch. */
    trialEndTime: string | undefined;
    /** Whether the subscription is in a 30-day trial. */
    isInTrial: boolean | undefined;
    /** Current suspension reasons. */
    suspensionReasons: string[] | undefined;
    /** Admin-console URL for the customer's subscriptions page. */
    resourceUiUrl: string | undefined;
    /** Resource kind (`reseller#subscription`). */
    kind: string | undefined;
    /** Deletion type used when the resource is destroyed. */
    deletionType: string;
  },
  never,
  Providers
>;

/**
 * A Google Workspace Reseller subscription for a customer SKU.
 *
 * Subscriptions have no labels field — Alchemy stamps ownership into
 * `purchaseOrderId` for `list` / nuke. `customerId` and `skuId` are
 * identity. Plan, seats, renewal settings, and suspension update in
 * place via `changePlan`, `changeSeats`, `changeRenewalSettings`,
 * `suspend`, and `activate`.
 *
 * Creating subscriptions requires Google Workspace Reseller access.
 *
 * ### Creating a Subscription
 * **Example:** Flexible plan
 * ```typescript
 * const subscription = yield* GCP.Reseller.Subscription("Workspace", {
 *   customerId: "C012345",
 *   skuId: "Google-Apps",
 *   planName: "FLEXIBLE",
 *   seats: { maximumNumberOfSeats: 10 },
 * });
 * ```
 *
 * **Example:** Annual commitment
 * ```typescript
 * const subscription = yield* GCP.Reseller.Subscription("Workspace", {
 *   customerId: "C012345",
 *   skuId: "1010020027",
 *   planName: "ANNUAL_MONTHLY_PAY",
 *   seats: { numberOfSeats: 10 },
 *   renewalType: "AUTO_RENEW_MONTHLY_PAY",
 * });
 * ```
 *
 * ### Updating a Subscription
 * **Example:** Change seat count
 * ```typescript
 * const subscription = yield* GCP.Reseller.Subscription("Workspace", {
 *   customerId: existing.customerId,
 *   skuId: existing.skuId,
 *   planName: "FLEXIBLE",
 *   seats: { maximumNumberOfSeats: 25 },
 * });
 * ```
 *
 * ### Cancelling a Subscription
 * **Example:** Transfer to direct on destroy
 * ```typescript
 * const subscription = yield* GCP.Reseller.Subscription("Workspace", {
 *   customerId: "C012345",
 *   skuId: "Google-Apps",
 *   deletionType: "transfer_to_direct",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Reseller
 */
export const Subscription = Resource<Subscription>("GCP.Reseller.Subscription");

const deletionTypeOf = (
  value: string | undefined,
): reseller.DeleteSubscriptionsDeletionTypeEnum | (string & {}) =>
  value === "transfer_to_direct" ? "transfer_to_direct" : DEFAULT_DELETION_TYPE;

const renewalSettingsOf = (
  renewalType: string | undefined,
): reseller.RenewalSettings | undefined =>
  renewalType !== undefined && renewalType.length > 0
    ? { renewalType }
    : undefined;

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: [
      "customerId",
      "customerDomain",
      "skuId",
      "creationTime",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousCustomerId: olds?.customerId ?? output?.customerId,
        nextCustomerId: news.customerId,
        customerDomain: output?.customerDomain,
        previousSkuId: olds?.skuId ?? output?.skuId,
        nextSkuId: news.skuId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const customerId =
        toCustomerId(olds?.customerId ?? output?.customerId) ?? "";
      const subscriptionId =
        toSubscriptionId(olds?.subscriptionId ?? output?.subscriptionId) ?? "";
      let existing = yield* getSubscription(customerId, subscriptionId);
      if (existing === undefined) {
        existing = yield* findOwnedSubscription(id, customerId);
      }
      if (existing === undefined) {
        existing = yield* findOwnedBySku(
          id,
          customerId,
          olds?.skuId ?? output?.skuId ?? "",
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.deletionType ?? output?.deletionType,
      );
      return (yield* ownedByAlchemy(id, existing.purchaseOrderId))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedSubscriptions();
        return rows
          .filter((row) => hasOwnershipMarker(row.purchaseOrderId))
          .map((row) => toAttrs(row, env.project, DEFAULT_DELETION_TYPE));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const customerId = toCustomerId(news.customerId) ?? "";
      if (customerId.length === 0) {
        return yield* new CustomerIdRequired({ id });
      }
      const skuId = news.skuId.trim();
      if (skuId.length === 0) {
        return yield* new SkuIdRequired({ id });
      }
      const planName = news.planName ?? output?.planName ?? DEFAULT_PLAN_NAME;
      const seats = seatsForPlan(planName, news.seats ?? output?.seats);
      const deletionType = deletionTypeOf(
        news.deletionType ?? output?.deletionType,
      );
      const ownership = yield* ownershipLabels(id);
      const purchaseOrderId = encodePurchaseOrderId(
        ownership,
        news.purchaseOrderId,
      );
      const subscriptionId =
        toSubscriptionId(news.subscriptionId ?? output?.subscriptionId) ?? "";

      let current = yield* getSubscription(
        output?.customerId ?? customerId,
        subscriptionId,
      );
      if (current === undefined) {
        current = yield* findOwnedSubscription(id, customerId);
      }
      if (current === undefined) {
        current = yield* findOwnedBySku(id, customerId, skuId);
      }

      if (current === undefined) {
        const created = yield* reseller
          .insertSubscriptions({
            customerId,
            customerAuthToken: news.customerAuthToken,
            action: news.action,
            sourceSkuId: news.sourceSkuId,
            body: {
              skuId,
              plan: { planName },
              seats,
              purchaseOrderId,
              dealCode: news.dealCode,
              renewalSettings: renewalSettingsOf(news.renewalType),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedBySku(id, customerId, skuId).pipe(
                Effect.flatMap((owned) =>
                  owned !== undefined
                    ? Effect.succeed(owned)
                    : findBySku(customerId, skuId),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SubscriptionNotResolved({
          customerId,
          subscriptionId: subscriptionId || skuId,
        });
      }

      const currentCustomerId = toCustomerId(current.customerId) ?? customerId;
      const currentSubscriptionId =
        toSubscriptionId(current.subscriptionId) ?? subscriptionId;
      const observedPlan = current.plan?.planName;
      const planChanged = !planNamesEqual(observedPlan, planName);
      const seatsChanged = !seatsEqual(
        seatsForPlan(observedPlan ?? planName, current.seats),
        seats,
      );
      const dealChanged =
        news.dealCode !== undefined && current.dealCode !== news.dealCode;
      const renewalChanged =
        news.renewalType !== undefined &&
        (current.renewalSettings?.renewalType ?? "") !== news.renewalType;

      if (planChanged || dealChanged) {
        current = yield* retryConflict(
          reseller.changePlanSubscriptions({
            customerId: currentCustomerId,
            subscriptionId: currentSubscriptionId,
            body: {
              planName,
              seats,
              purchaseOrderId,
              dealCode: news.dealCode ?? current.dealCode,
            },
          }),
        );
      } else if (seatsChanged && seats !== undefined) {
        current = yield* retryConflict(
          reseller.changeSeatsSubscriptions({
            customerId: currentCustomerId,
            subscriptionId:
              toSubscriptionId(current.subscriptionId) ?? currentSubscriptionId,
            body: seats,
          }),
        );
      }

      const latestId =
        toSubscriptionId(current.subscriptionId) ?? currentSubscriptionId;
      if (renewalChanged && news.renewalType !== undefined) {
        current = yield* retryConflict(
          reseller.changeRenewalSettingsSubscriptions({
            customerId: currentCustomerId,
            subscriptionId: latestId,
            body: { renewalType: news.renewalType },
          }),
        );
      }

      const status = current.status ?? "";
      const latestAfterRenewal =
        toSubscriptionId(current.subscriptionId) ?? latestId;
      if (news.suspended === true && status === "ACTIVE") {
        current = yield* retryConflict(
          reseller.suspendSubscriptions({
            customerId: currentCustomerId,
            subscriptionId: latestAfterRenewal,
          }),
        );
      } else if (news.suspended === false && status === "SUSPENDED") {
        current = yield* retryConflict(
          reseller.activateSubscriptions({
            customerId: currentCustomerId,
            subscriptionId: latestAfterRenewal,
          }),
        );
      }

      if (news.startPaidService === true && current.trialSettings?.isInTrial) {
        current = yield* retryConflict(
          reseller.startPaidServiceSubscriptions({
            customerId: currentCustomerId,
            subscriptionId:
              toSubscriptionId(current.subscriptionId) ?? latestAfterRenewal,
          }),
        );
      }

      const latest =
        (yield* getSubscription(
          toCustomerId(current.customerId) ?? currentCustomerId,
          toSubscriptionId(current.subscriptionId) ?? latestAfterRenewal,
        )) ?? current;
      return toAttrs(latest, env.project, deletionType);
    }),

    delete: Effect.fn(function* ({ output }) {
      const customerId = toCustomerId(output.customerId) ?? "";
      const subscriptionId = toSubscriptionId(output.subscriptionId) ?? "";
      if (customerId.length === 0 || subscriptionId.length === 0) return;
      yield* retryConflict(
        reseller.deleteSubscriptions({
          customerId,
          subscriptionId,
          deletionType: deletionTypeOf(output.deletionType),
        }),
      ).pipe(
        ignoreMissing,
        Effect.catchTag("Conflict", () => Effect.void),
      );
    }),
  });
