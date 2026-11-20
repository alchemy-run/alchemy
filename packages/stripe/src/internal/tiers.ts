/** How a tiered price or plan applies its tiers. */
export type TiersMode = "graduated" | "volume";

/** One tier of a tiered price or plan. */
export interface Tier {
  /**
   * Inclusive upper bound of the tier in units. The last tier uses
   * `"inf"`.
   */
  upTo: number | "inf";
  /**
   * Per-unit amount in the currency's minor units for units in this tier.
   */
  unitAmount?: number;
  /**
   * Same as `unitAmount`, as a decimal string with at most 12 decimal
   * places. Mutually exclusive with `unitAmount`.
   */
  unitAmountDecimal?: string;
  /**
   * Flat amount in the currency's minor units added once for this tier.
   */
  flatAmount?: number;
  /**
   * Same as `flatAmount`, as a decimal string. Mutually exclusive with
   * `flatAmount`.
   */
  flatAmountDecimal?: string;
}

/** A tier as Stripe returns it on a Price or Plan. */
interface WireTier {
  up_to: number | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  flat_amount: number | null;
  flat_amount_decimal: string | null;
}

/**
 * Stripe echoes a decimal amount for every whole amount (`unit_amount: 500`
 * comes back with `unit_amount_decimal: "500"`), so a decimal is only kept
 * when no whole amount is set.
 */
export const fromWireTiers = (
  tiers: ReadonlyArray<WireTier> | null | undefined,
): Tier[] | undefined =>
  tiers?.map((tier) => ({
    upTo: tier.up_to ?? "inf",
    ...(tier.unit_amount != null
      ? { unitAmount: tier.unit_amount }
      : tier.unit_amount_decimal != null
        ? { unitAmountDecimal: tier.unit_amount_decimal }
        : {}),
    ...(tier.flat_amount != null
      ? { flatAmount: tier.flat_amount }
      : tier.flat_amount_decimal != null
        ? { flatAmountDecimal: tier.flat_amount_decimal }
        : {}),
  }));

export const toWireTiers = (tiers: ReadonlyArray<Tier>) =>
  tiers.map((tier) => ({
    up_to: tier.upTo,
    ...(tier.unitAmount !== undefined ? { unit_amount: tier.unitAmount } : {}),
    ...(tier.unitAmountDecimal !== undefined
      ? { unit_amount_decimal: tier.unitAmountDecimal }
      : {}),
    ...(tier.flatAmount !== undefined ? { flat_amount: tier.flatAmount } : {}),
    ...(tier.flatAmountDecimal !== undefined
      ? { flat_amount_decimal: tier.flatAmountDecimal }
      : {}),
  }));

/** Decimal strings compare by value: Stripe normalizes `"1.50"` to `"1.5"`. */
const decimalEqual = (a: string | undefined, b: string | undefined) =>
  a === undefined || b === undefined ? a === b : Number(a) === Number(b);

/** `undefined` desired tiers match anything: the prop was omitted. */
export const tiersEqual = (
  desired: ReadonlyArray<Tier> | undefined,
  observed: ReadonlyArray<Tier> | undefined,
): boolean => {
  if (desired === undefined) return true;
  if (observed === undefined || desired.length !== observed.length) return false;
  return desired.every((tier, index) => {
    const other = observed[index];
    return (
      other !== undefined &&
      tier.upTo === other.upTo &&
      tier.unitAmount === other.unitAmount &&
      decimalEqual(tier.unitAmountDecimal, other.unitAmountDecimal) &&
      tier.flatAmount === other.flatAmount &&
      decimalEqual(tier.flatAmountDecimal, other.flatAmountDecimal)
    );
  });
};
