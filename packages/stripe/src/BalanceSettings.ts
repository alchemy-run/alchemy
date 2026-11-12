import {
  CreateBalanceSettings,
  GetBalanceSettings,
  type BalanceSettings as StripeBalanceSettings,
  type CreateBalanceSettingsRequest,
} from "@distilled.cloud/stripe/stripe";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { subsetDiffers } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import { fromWire, toWire } from "./internal/case.ts";
import { atSpecApiVersion } from "./internal/version.ts";
import type { Providers } from "./Providers.ts";

/** How often Stripe pays out the balance. */
export interface BalanceSettingsPayoutSchedule {
  /** `daily`, `weekly`, `monthly`, or `manual` (no automatic payouts). */
  interval?: "daily" | "manual" | "monthly" | "weekly";
  /** Days of the month to pay out on, for a `monthly` schedule (1–31). */
  monthlyPayoutDays?: number[];
  /** Days of the week to pay out on, for a `weekly` schedule. */
  weeklyPayoutDays?: ("friday" | "monday" | "thursday" | "tuesday" | "wednesday")[];
}

/** Payout settings. */
export interface BalanceSettingsPayouts {
  /** When automatic payouts happen. */
  schedule?: BalanceSettingsPayoutSchedule;
  /** Text on the bank statement for automatic payouts (up to 22 characters). */
  statementDescriptor?: string;
  /**
   * Amount, in minor units, to keep in the balance per currency (e.g.
   * `{ usd: 10_000 }` keeps $100 back from each payout).
   */
  minimumBalanceByCurrency?: Record<string, number>;
}

/** Settings for the balance that collects payments. */
export interface BalanceSettingsPayments {
  /**
   * Whether Stripe may debit the bank account to cover a negative balance.
   */
  debitNegativeBalances?: boolean;
  /** Payout settings. */
  payouts?: BalanceSettingsPayouts;
  /** When charges settle into the available balance. */
  settlementTiming?: {
    /** Days to hold funds before they become available, overriding the account default. */
    delayDaysOverride?: number;
  };
}

export interface BalanceSettingsProps {
  /**
   * Settings for the balance that collects payments. Only the fields set
   * here are managed; destroy restores them to their values from before
   * the first deploy.
   */
  payments: BalanceSettingsPayments;
}

export type BalanceSettings = Resource<
  "Stripe.BalanceSettings",
  BalanceSettingsProps,
  {
    /** Current payment balance settings. */
    payments: BalanceSettingsPayments & {
      payouts?: BalanceSettingsPayouts & { status?: "disabled" | "enabled" };
      settlementTiming?: { delayDays?: number; delayDaysOverride?: number };
    };
    /**
     * The managed fields as they were before the first deploy, restored on
     * destroy. `null` marks a field that was unset, which Stripe can't
     * restore.
     */
    initialPayments: BalanceSettingsPayments;
  },
  never,
  Providers
>;

/**
 * The account's balance settings — payout schedule, payout statement
 * descriptor, minimum balances, negative-balance debits, and settlement
 * delay.
 *
 * This is an account singleton: it always exists and is updated in place.
 * The first deploy captures the values of the fields you set; destroy
 * writes those values back, so tearing down a stack leaves payouts as it
 * found them.
 *
 * @see https://docs.stripe.com/api/balance-settings
 *
 * ### Payout schedule
 * **Example:** Weekly payouts on Friday
 * ```typescript
 * const balance = yield* Stripe.BalanceSettings("balance", {
 *   payments: {
 *     payouts: {
 *       schedule: { interval: "weekly", weeklyPayoutDays: ["friday"] },
 *       statementDescriptor: "ACME PAYOUT",
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Manual payouts with a reserve
 * ```typescript
 * const balance = yield* Stripe.BalanceSettings("balance", {
 *   payments: {
 *     payouts: {
 *       schedule: { interval: "manual" },
 *       minimumBalanceByCurrency: { usd: 10_000 },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Payouts
 */
export const BalanceSettings = Resource<BalanceSettings>("Stripe.BalanceSettings");

type BalanceSettingsAttributes = BalanceSettings["Attributes"];

const observedPayments = (settings: StripeBalanceSettings) =>
  fromWire<BalanceSettingsAttributes["payments"]>(settings.payments);

/**
 * The observed value of every field `desired` sets, so destroy can put each
 * one back. A field Stripe reports as unset is recorded as `null`, so a
 * later deploy never mistakes a value Alchemy wrote for the original.
 */
const pick = (desired: unknown, observed: unknown): unknown => {
  if (typeof desired !== "object" || desired === null || Array.isArray(desired)) {
    return observed ?? null;
  }
  const nested = typeof observed === "object" && observed !== null ? observed : {};
  return Object.fromEntries(
    Object.entries(desired).map(([key, value]) => [
      key,
      pick(value, (nested as Record<string, unknown>)[key]),
    ]),
  );
};

/** Deep merge where `earlier` wins: a field captured once keeps its first value. */
const mergeCaptured = (later: unknown, earlier: unknown): unknown => {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(later) || !isObject(earlier)) return earlier !== undefined ? earlier : later;
  const keys = new Set([...Object.keys(later), ...Object.keys(earlier)]);
  return Object.fromEntries([...keys].map((key) => [key, mergeCaptured(later[key], earlier[key])]));
};

// Balance settings nest under `payments` only from the spec's API version.
const get = () => GetBalanceSettings({}).pipe(atSpecApiVersion);

const update = (payments: BalanceSettingsPayments) =>
  CreateBalanceSettings({
    payments: toWire<NonNullable<CreateBalanceSettingsRequest["payments"]>>(payments),
  }).pipe(atSpecApiVersion);

export const BalanceSettingsProvider = () =>
  Provider.succeed(BalanceSettings, {
    stables: ["initialPayments"],

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const settings = yield* get();
      return {
        payments: observedPayments(settings),
        initialPayments: output?.initialPayments ?? {},
      };
    }),

    // A singleton is never torn down by nuke.
    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const current = yield* get();
      const observed = observedPayments(current);
      // Capture each managed field the first time it is managed.
      const captured = pick(news.payments, observed) as BalanceSettingsPayments | undefined;
      const initialPayments = (mergeCaptured(captured ?? {}, output?.initialPayments) ??
        {}) as BalanceSettingsPayments;

      if (!subsetDiffers(news.payments, observed)) {
        return { payments: observed, initialPayments };
      }
      const updated = yield* update(news.payments);
      return { payments: observedPayments(updated), initialPayments };
    }),

    delete: Effect.fn(function* ({ output }) {
      if (Object.keys(output.initialPayments).length === 0) return;
      const current = yield* get();
      // An unset (`null`) statement descriptor is cleared with `""`; other
      // unset fields can't be restored to unset, and toWire drops them.
      const initial = output.initialPayments;
      const restorable = fromWire<BalanceSettingsPayments>(
        initial.payouts?.statementDescriptor === null
          ? { ...initial, payouts: { ...initial.payouts, statementDescriptor: "" } }
          : initial,
      );
      const observed = observedPayments(current);
      const descriptorCleared =
        restorable.payouts?.statementDescriptor === "" &&
        observed.payouts?.statementDescriptor === undefined;
      const { statementDescriptor: _, ...payoutsWithoutDescriptor } = restorable.payouts ?? {};
      const comparable = descriptorCleared
        ? { ...restorable, payouts: payoutsWithoutDescriptor }
        : restorable;
      if (!subsetDiffers(comparable, observed)) return;
      yield* update(restorable);
    }),
  });
