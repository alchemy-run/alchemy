import * as Anthropic from "@distilled.cloud/anthropic";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** Window a spend limit resets over. */
export type SpendLimitPeriod = "daily" | "weekly" | "monthly";

export interface SpendLimitProps {
  /**
   * Tagged ID of the organization member the limit applies to (`user_…`).
   * Changing it replaces the spend limit.
   */
  userId: string;
  /**
   * Cap on the member's spend within each period, in the minor unit of the
   * organization's billing currency (cents for USD): `50000` is $500.00.
   * `null` sets an explicit no-limit override for this member and period.
   */
  amount: number | null;
  /**
   * Window the limit resets over. Each period resolves independently, so a
   * member can carry a daily and a monthly cap at once (one resource each).
   * Changing it replaces the spend limit.
   * @default "monthly"
   */
  period?: SpendLimitPeriod;
}

export interface SpendLimitAttributes {
  /** Tagged ID of the spend limit (`spl_…`). */
  spendLimitId: string;
  /** Member the limit applies to. */
  userId: string;
  /** Window the limit resets over. */
  period: SpendLimitPeriod;
  /** Cap in minor currency units, or `null` for an explicit no-limit override. */
  amount: number | null;
  /** ISO 4217 code of the organization's billing currency — the unit of `amount`. */
  currency: string;
  /** RFC 3339 creation timestamp. */
  createdAt: string;
  /** RFC 3339 last-modified timestamp. */
  updatedAt: string;
}

export type SpendLimit = Resource<
  "Anthropic.SpendLimit",
  SpendLimitProps,
  SpendLimitAttributes,
  never,
  Providers
>;

/**
 * A per-member spend limit in an Anthropic organization: caps how much one
 * member can spend per day, week or month. Managed through the Admin API,
 * so it needs an Admin API key (`ANTHROPIC_ADMIN_KEY`).
 *
 * Anthropic keys spend limits by member and period, and setting one is an
 * upsert. When a limit for the same member and period already exists and was
 * not created by this stack, deploy refuses to take it over unless adoption
 * is enabled (`--adopt`). Destroying the resource deletes the limit, so the
 * member falls back to whatever broader limit applies.
 *
 * ### Capping a Member's Spend
 * **Example:** $500 per month
 * ```typescript
 * const limit = yield* Anthropic.SpendLimit("AliceMonthly", {
 *   userId: "user_01WCz1FkmYMm4gnmykNKUu3Q",
 *   amount: 50_000,
 * });
 * ```
 *
 * **Example:** Daily cap alongside a monthly one
 * ```typescript
 * yield* Anthropic.SpendLimit("AliceDaily", {
 *   userId: "user_01WCz1FkmYMm4gnmykNKUu3Q",
 *   amount: 5_000,
 *   period: "daily",
 * });
 * ```
 *
 * **Example:** Explicitly lift a broader limit for one member
 * ```typescript
 * yield* Anthropic.SpendLimit("OnCallUnlimited", {
 *   userId: "user_01WCz1FkmYMm4gnmykNKUu3Q",
 *   amount: null,
 * });
 * ```
 *
 * @resource
 * @product Anthropic
 * @category AI
 */
export const SpendLimit = Resource<SpendLimit>("Anthropic.SpendLimit");

const DEFAULT_PERIOD: SpendLimitPeriod = "monthly";

const toAmount = (amount: string | null): number | null =>
  amount === null ? null : Number(amount);
const fromAmount = (amount: number | null): string | null =>
  amount === null ? null : String(Math.trunc(amount));

const userIdOf = (scope: Anthropic.BetaSpendLimitScope): string | undefined =>
  scope.type === "user" && "user_id" in scope ? scope.user_id : undefined;

const toAttrs = (limit: Anthropic.BetaSpendLimit, userId: string): SpendLimitAttributes => ({
  spendLimitId: limit.id,
  userId: userIdOf(limit.scope) ?? userId,
  period: limit.period as SpendLimitPeriod,
  amount: toAmount(limit.amount),
  currency: limit.currency,
  createdAt: limit.created_at,
  updatedAt: limit.updated_at,
});

const getById = (spendLimitId: string) =>
  Anthropic.getSpendLimit({ spend_limit_id: spendLimitId }).pipe(
    Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a member-scoped limit for (userId, period) through the effective-limit
 * report — the only Admin API view that maps a member to their limit id.
 */
const findForMember = (userId: string, period: SpendLimitPeriod) =>
  Anthropic.listEffectiveSpendLimits.items({ user_ids__: [userId], period__: [period] }).pipe(
    Stream.filter((row) => {
      const source = row.source as { type?: string; user_id?: string };
      return row.period === period && source.type === "user" && source.user_id === userId;
    }),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((row) =>
      row === undefined ? Effect.succeed(undefined) : getById(row.spend_limit_id),
    ),
  );

export const SpendLimitProvider = () =>
  Provider.succeed(SpendLimit, {
    stables: ["spendLimitId", "userId", "period", "currency", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId;
      const previousPeriod = olds?.period ?? output?.period ?? DEFAULT_PERIOD;
      if (
        (previousUser !== undefined && news.userId !== previousUser) ||
        (news.period ?? DEFAULT_PERIOD) !== previousPeriod
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      if (output?.spendLimitId !== undefined) {
        const limit = yield* getById(output.spendLimitId);
        if (limit !== undefined) return toAttrs(limit, output.userId);
      }
      const userId = olds?.userId ?? output?.userId;
      if (userId === undefined) return undefined;
      // A limit we did not record is foreign: spend limits carry no tags to
      // prove ownership, so gate the takeover behind adoption.
      const existing = yield* findForMember(userId, olds?.period ?? DEFAULT_PERIOD);
      return existing === undefined ? undefined : Unowned(toAttrs(existing, userId));
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const period = news.period ?? DEFAULT_PERIOD;
      const desiredAmount = news.amount === null ? null : Math.trunc(news.amount);

      // Observe — the cached id is only a hint; the limit may have been
      // deleted (or replaced) out of band.
      const observed =
        output?.spendLimitId !== undefined ? yield* getById(output.spendLimitId) : undefined;
      if (
        observed !== undefined &&
        observed.period === period &&
        userIdOf(observed.scope) === news.userId &&
        toAmount(observed.amount) === desiredAmount
      ) {
        return toAttrs(observed, news.userId);
      }

      // Ensure + sync — setting a limit is an upsert keyed by member and
      // period, so one call both creates and updates.
      const limit = yield* Anthropic.setSpendLimit({
        amount: fromAmount(desiredAmount),
        period,
        scope: { type: "user", user_id: news.userId },
      });
      return toAttrs(limit, news.userId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Anthropic.deleteSpendLimit({ spend_limit_id: output.spendLimitId }).pipe(
        Effect.catchTag("ResourceNotFound", () => Effect.void),
      );
    }),
  });
