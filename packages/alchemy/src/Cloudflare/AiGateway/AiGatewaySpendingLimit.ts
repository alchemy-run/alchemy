import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/** Reset cadence for the spend window. */
export type AiGatewaySpendingLimitDuration = "daily" | "weekly" | "monthly";

/**
 * Enforcement algorithm — `fixed` resets the counter on the window boundary,
 * `sliding` tracks a rolling window. Mirrors the gateway's rate-limiting
 * `technique` semantics.
 */
export type AiGatewaySpendingLimitStrategy = "fixed" | "sliding";

export type AiGatewaySpendingLimitTopUp = {
  /**
   * Top-up amount, **in cents** (Cloudflare's minimum is `10_00` =
   * $10.00). Used both for the one-time bootstrap charge and as the
   * recharge amount when `autoRecharge` is enabled. Charged to the
   * account's default payment method via a Stripe PaymentIntent.
   */
  amount: number;
  /**
   * Automatically recharge the account by `amount` whenever the credit
   * balance drops below `threshold` (Cloudflare's auto top-up config,
   * `POST /ai-gateway/billing/topup/config`). Set to `false` to remove
   * any auto top-up config from the account.
   *
   * @default true
   */
  autoRecharge?: boolean;
  /**
   * Balance threshold, **in cents**, that triggers an auto recharge
   * (Cloudflare's minimum is `5_00` = $5.00). Only meaningful while
   * `autoRecharge` is enabled.
   *
   * @default 5_00 ($5.00)
   */
  threshold?: number;
};

export type AiGatewaySpendingLimitProps = {
  /**
   * Spending limit, **in cents** (Cloudflare's native unit; minimum `1_00` =
   * $1.00). Tracks cumulative AI Gateway spend across the account.
   *
   * @default 10_00 ($10.00)
   */
  amount?: number;
  /**
   * Window over which `amount` accumulates before reset/roll-off.
   */
  duration: AiGatewaySpendingLimitDuration;
  /**
   * Enforcement algorithm.
   *
   * @default "fixed"
   */
  strategy?: AiGatewaySpendingLimitStrategy;
  /**
   * Cloudflare refuses to set an account spending limit until the account
   * has loaded Unified Billing credits via at least one **manual top-up**
   * (`NO_MANUAL_TOPUP`). The provider reconciles this against the live
   * billing state: it observes `first_topup_success` on the billing API
   * and only makes the one-time credit top-up (charging the account's
   * default payment method) when the account has never topped up. Once
   * the account is bootstrapped this prop is inert and never charges
   * again.
   *
   * Requires a default payment method on the account; if the payment
   * needs interactive confirmation (e.g. 3-D Secure), the resource fails
   * with `AiGatewaySpendingLimitTopupRequired` and the top-up must be
   * completed in the dashboard.
   */
  topUp: AiGatewaySpendingLimitTopUp;
};

export type AiGatewaySpendingLimit = Resource<
  "Cloudflare.AiGatewaySpendingLimit",
  AiGatewaySpendingLimitProps,
  {
    accountId: string;
    amount: number;
    duration: AiGatewaySpendingLimitDuration;
    strategy: AiGatewaySpendingLimitStrategy;
    /** Whether Cloudflare currently reports the limit as active. */
    enabled: boolean;
    /**
     * The auto top-up config active on the account, or `undefined` when
     * auto recharge is disabled.
     */
    autoRecharge: { amount: number; threshold: number } | undefined;
  },
  never,
  Providers
>;

/**
 * The account has never loaded Unified Billing credits via a manual top-up,
 * so Cloudflare refuses to set an account-level spending limit
 * (`NO_MANUAL_TOPUP`, code 1000). Resolve by setting the `topUp` prop so
 * the provider bootstraps the account automatically, or by making a
 * one-time credit top-up in the dashboard (AI > AI Gateway > Billing).
 */
export class AiGatewaySpendingLimitTopupRequired extends Data.TaggedError(
  "AiGatewaySpendingLimitTopupRequired",
)<{
  readonly accountId: string;
  readonly message: string;
}> {}

export const isAiGatewaySpendingLimit = (
  value: unknown,
): value is AiGatewaySpendingLimit =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiGatewaySpendingLimit).Type ===
    "Cloudflare.AiGatewaySpendingLimit";

/**
 * The account-level Cloudflare AI Gateway spending limit — a hard dollar cap
 * on cumulative spend across every gateway in the account's Unified Billing.
 *
 * This is a **per-account singleton**: Cloudflare stores a single limit per
 * account (`/accounts/{account_id}/ai-gateway/billing/spending-limit`), so
 * declaring more than one `AiGatewaySpendingLimit` against the same account
 * will make them fight over the same remote object. Declare exactly one.
 * @resource
 * @product AI Gateway
 * @category AI
 * @section Setting a spend cap
 * @example Monthly cap
 * ```ts
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * // Cloudflare requires one manual credit top-up before a spending limit
 * // can be set. `topUp` reconciles that requirement: the provider observes
 * // the billing state and only charges the account's default payment
 * // method if the account has never topped up.
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 250_00, // cents -> $250.00 (minimum 1_00 = $1.00)
 *   duration: "monthly",
 *   topUp: { amount: 10_00 }, // cents -> $10.00 (Cloudflare minimum)
 * });
 * ```
 *
 * @example Sliding daily window
 * ```ts
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 50_00, // cents -> $50.00
 *   duration: "daily",
 *   strategy: "sliding",
 *   topUp: { amount: 10_00 },
 * });
 * ```
 *
 * @section Auto recharge
 * @example Customize the recharge threshold
 * ```ts
 * // Auto recharge is on by default: when the credit balance drops below
 * // `threshold`, Cloudflare recharges by `amount` automatically.
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 250_00,
 *   duration: "monthly",
 *   topUp: { amount: 20_00, threshold: 10_00 }, // recharge $20 below $10
 * });
 * ```
 *
 * @example Disable auto recharge
 * ```ts
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 250_00,
 *   duration: "monthly",
 *   topUp: { amount: 10_00, autoRecharge: false }, // one-time bootstrap only
 * });
 * ```
 */
export const AiGatewaySpendingLimit = Resource<AiGatewaySpendingLimit>(
  "Cloudflare.AiGatewaySpendingLimit",
);

export const AiGatewaySpendingLimitProvider = () =>
  Provider.succeed(AiGatewaySpendingLimit, {
    stables: ["accountId"],
    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // The limit is keyed solely by account; an account change is the
      // only structural identity change and forces a replace.
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldMutable = mutable(output ?? desired(olds));
      const nextMutable = mutable(desired(news));
      if (!deepEqual(oldMutable, nextMutable)) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const next = desired(news);

      // Observe — Cloudflare gates the account spending limit behind
      // Unified Billing: the account must have completed one manual
      // credit top-up or the limit POST is rejected (NoManualTopup).
      // Read the live billing state to know whether it's bootstrapped.
      const billing = yield* aiGateway.creditBalanceBilling({ accountId });

      // Ensure — one-time bootstrap charge, only when the observed state
      // says the account has never topped up. This is the only call that
      // charges the card; once `firstTopupSuccess` is true it is never
      // made again.
      if (billing.firstTopupSuccess !== true) {
        yield* aiGateway.createBillingTopup({
          accountId,
          amount: news.topUp.amount,
        });
      }

      // Sync — upsert the desired shape onto this per-account singleton;
      // adoption, drift, and routine updates all converge through the one
      // POST. A freshly submitted top-up settles asynchronously, so retry
      // while Cloudflare still reports NoManualTopup — bounded, so a
      // payment stuck on interactive confirmation fails fast with an
      // actionable error.
      yield* aiGateway
        .createBillingSpendingLimit({
          accountId,
          amount: next.amount,
          duration: next.duration,
          strategy: next.strategy,
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            while: (e) => e._tag === "NoManualTopup",
            times: 8,
          }),
          Effect.catchTag("NoManualTopup", () =>
            Effect.fail(
              new AiGatewaySpendingLimitTopupRequired({
                accountId,
                message:
                  `A credit top-up of ${news.topUp.amount} cents was submitted for ` +
                  `account ${accountId} but Cloudflare still reports NO_MANUAL_TOPUP. ` +
                  "The payment may require interactive confirmation (e.g. 3-D Secure) — " +
                  "complete it in the Cloudflare dashboard (AI > AI Gateway > Billing) " +
                  "and retry.",
              }),
            ),
          ),
        );

      // Sync — auto-recharge config: diff the observed `topupConfig`
      // (already read above) against the desired shape and apply only the
      // delta, skipping the API entirely on a no-op. Configuring auto
      // top-up does not charge by itself — Cloudflare only charges later
      // if the balance ever drops below the threshold.
      const observedRecharge = observedAutoRecharge(billing.topupConfig);
      if (next.autoRecharge === undefined) {
        if (observedRecharge !== undefined) {
          yield* aiGateway.deleteBillingTopupConfig({ accountId });
        }
      } else if (!deepEqual(observedRecharge, next.autoRecharge)) {
        yield* aiGateway.createBillingTopupConfig({
          accountId,
          amount: next.autoRecharge.amount,
          threshold: next.autoRecharge.threshold,
        });
      }

      // The create returns no body and the stored state is exactly what
      // we send, so report the applied shape directly rather than paying
      // a read-back GET.
      return { accountId, ...next, enabled: true };
    }),
    delete: Effect.fn(function* ({ output }) {
      // DELETE on the spending-limit endpoint is idempotent — removing an
      // absent limit is a server-side no-op.
      yield* aiGateway.deleteBillingSpendingLimit({
        accountId: output.accountId,
      });
      // The auto-recharge config is owned by this resource; remove it so
      // the account stops recharging once the cap is gone.
      if (output.autoRecharge !== undefined) {
        yield* aiGateway.deleteBillingTopupConfig({
          accountId: output.accountId,
        });
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const current = yield* aiGateway.getBillingSpendingLimit({
        accountId: acct,
      });
      // A disabled limit means there is no resource to track.
      if (!current.enabled) return undefined;
      const billing = yield* aiGateway.creditBalanceBilling({
        accountId: acct,
      });
      // GET config fields are nullable; prefer the server's view and fall
      // back to the prior known shape.
      const prior = output ?? desired(olds);
      return {
        accountId: acct,
        amount: current.config.amount ?? prior.amount,
        duration: (current.config.duration ??
          prior.duration) as AiGatewaySpendingLimitDuration,
        strategy: (current.config.strategy ??
          prior.strategy) as AiGatewaySpendingLimitStrategy,
        enabled: current.enabled,
        autoRecharge: observedAutoRecharge(billing.topupConfig),
      };
    }),
    // Per-account singleton: Cloudflare stores a single spending limit per
    // account (`/accounts/{account_id}/ai-gateway/billing/spending-limit`),
    // so there is no collection API to paginate. Observe the one instance
    // for the ambient account and return it as a one-element array — or `[]`
    // when no limit is currently set (mirrors `read` returning `undefined`).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const current = yield* aiGateway.getBillingSpendingLimit({
        accountId,
      });
      if (!current.enabled) return [];
      const billing = yield* aiGateway.creditBalanceBilling({
        accountId,
      });
      const defaults = desired(undefined);
      return [
        {
          accountId,
          amount: current.config.amount ?? defaults.amount,
          duration: (current.config.duration ??
            defaults.duration) as AiGatewaySpendingLimitDuration,
          strategy: (current.config.strategy ??
            defaults.strategy) as AiGatewaySpendingLimitStrategy,
          enabled: current.enabled,
          autoRecharge: observedAutoRecharge(billing.topupConfig),
        },
      ];
    }),
  });

// Normalize the observed `topup_config` into the attribute shape. An
// unset config comes back as zeros/nulls rather than being absent.
const observedAutoRecharge = (config: {
  amount: number | null;
  threshold: number | null;
}) =>
  (config.amount ?? 0) > 0
    ? { amount: config.amount!, threshold: config.threshold ?? 0 }
    : undefined;

// Resolve the desired config from props (or from cached attributes /
// prior props), applying defaults. Accepts the loose overlap shared by
// Props (which carry `topUp`), Attributes (which carry the resolved
// `autoRecharge`), `olds`, and `output`.
const desired = (props?: {
  amount?: number;
  duration?: string;
  strategy?: string;
  topUp?: AiGatewaySpendingLimitTopUp;
  autoRecharge?: { amount: number; threshold: number } | undefined;
}) => ({
  amount: props?.amount ?? 10_00,
  duration: (props?.duration ?? "monthly") as AiGatewaySpendingLimitDuration,
  strategy: (props?.strategy ?? "fixed") as AiGatewaySpendingLimitStrategy,
  autoRecharge:
    props?.autoRecharge ??
    (props?.topUp !== undefined && props.topUp.autoRecharge !== false
      ? {
          amount: props.topUp.amount,
          threshold: props.topUp.threshold ?? 5_00,
        }
      : undefined),
});

// Fields that, when changed, drive an in-place update vs. a replace.
const mutable = (v: {
  amount: number;
  duration: string;
  strategy: string;
  autoRecharge?: { amount: number; threshold: number } | undefined;
}) => ({
  amount: v.amount,
  duration: v.duration,
  strategy: v.strategy,
  autoRecharge: v.autoRecharge,
});
