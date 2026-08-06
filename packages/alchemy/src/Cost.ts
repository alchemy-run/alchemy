/**
 * Platform-neutral cost-estimation types. A provider (Cloudflare, AWS, GCP,
 * ...) attaches an optional {@link ResourceCost} to any resource's
 * `ProviderService` (see `Provider.ts`) to make it show up in `alchemy
 * plan`'s cost summary. Nothing here is Cloudflare-specific — see
 * `Cloudflare/CloudflarePricing.ts` for the first real implementation.
 */
import * as Effect from "effect/Effect";
import { isResolved } from "./Diff.ts";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";

/**
 * A single usage-based billing dimension, shown as a reference rate — never
 * summed into a total, since actual usage is unknowable at plan time.
 */
export interface RateLine {
  /** Human-readable name of the billing dimension, e.g. "Workers requests". */
  label: string;
  /** Price per {@link unit}, in USD. */
  perUnit: number;
  /** What {@link perUnit} is priced per, e.g. "million requests". */
  unit: string;
  /** Included free monthly allotment, if any, e.g. "10M/mo free". */
  freeIncluded?: string;
}

/**
 * Cost model for one resource type. Every function is pure (no I/O, no
 * Effect) — but, exactly like a provider `diff`'s `news` (see
 * `Provider.ts`), the props it receives are *plan-time* values that may
 * still be, or contain, unresolved `Output`s: a prop wired to another
 * resource's attribute has no value until that resource deploys. Read any
 * prop that changes the price through {@link planProp} rather than
 * directly — an unresolved prop must degrade to a labeled default, never
 * be mis-priced (an `Output` object indexed into a rate table silently
 * prices as `undefined`/$0).
 */
export interface ResourceCost<Props = any> {
  /**
   * Deterministic floor: what this resource costs per month with zero
   * usage. Mostly `0` — a provisioned-capacity resource (e.g. a Cloudflare
   * Container's memory/disk baseline) is the main exception.
   */
  floorMonthlyUsd: (props: Input<Props> | undefined) => number;
  /**
   * Per-unit rates for the usage-based dimensions of this resource —
   * reference only, intentionally never summed into a total.
   */
  rates: (props: Input<Props> | undefined) => RateLine[];
  /**
   * Whether deploying this resource requires a paid plan tier (e.g.
   * Cloudflare's $5/mo Workers Paid plan). Used so a plan-wide cost summary
   * can add that base fee exactly once, no matter how many paid-plan
   * resources are touched together.
   */
  requiresPaidPlan: boolean;
}

/** What {@link planProp} found for one prop at plan time. */
export interface PlanProp<T> {
  /** The prop's value when it is known at plan time, else `undefined`. */
  value: T | undefined;
  /**
   * True when the prop is present but still an unresolved plan-time
   * expression (an `Output`/`Effect` whose value only exists after
   * deploy). Distinguished from plain absence so a pricing model can *say*
   * it is showing a default rather than presenting the default as chosen.
   */
  unresolved: boolean;
}

/**
 * Reads one prop off plan-time props. Pricing runs during `alchemy plan`,
 * so — like a provider `diff`'s `news` — the props may be, or contain,
 * unresolved `Output`s; this is the safe accessor {@link ResourceCost}
 * implementations use for any prop that changes the price.
 */
export const planProp = <Props, K extends keyof Props>(
  props: Input<Props> | undefined,
  key: K,
): PlanProp<Props[K]> => {
  if (props == null) {
    return { value: undefined, unresolved: false };
  }
  if (Output.isOutput(props) || Effect.isEffect(props)) {
    // The whole props bag is a single unresolved expression — every prop
    // inside it is unknown until deploy.
    return { value: undefined, unresolved: true };
  }
  const value = (props as Props)[key];
  if (value === undefined) {
    return { value: undefined, unresolved: false };
  }
  return isResolved<Props[K]>(value)
    ? { value, unresolved: false }
    : { value: undefined, unresolved: true };
};
