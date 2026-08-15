/**
 * Shared Edge Config declaration for the aggregate smoke chain.
 *
 * Registration is FQN-idempotent: the TEST program registers
 * `Vercel.EdgeConfig("SmokeFlags", { items })` FIRST each cycle (with that
 * cycle's declarative item set), so the fixture Function's later
 * `yield* SmokeFlags` resolves to the same instance — the fixture's
 * `BASE_ITEMS` are only a fallback if the Function is ever deployed alone.
 */
import * as Vercel from "@/Vercel/index.ts";

export const BASE_ITEMS = {
  greeting: "hello",
  enableCheckout: true,
  limits: { maxItems: 3 },
};

export const SmokeFlags = Vercel.EdgeConfig("SmokeFlags", {
  items: { ...BASE_ITEMS },
});
