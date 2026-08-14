/**
 * Shared Edge Config declaration — yielded by BOTH the Function fixture
 * (to bind it) and the test's deploy program (to read its attributes):
 * resource registration is FQN-idempotent, so both yields resolve to the
 * same instance.
 */
import * as Vercel from "@/Vercel/index.ts";

/** The declarative item set under test (asserted by the test out-of-band). */
export const FIXTURE_ITEMS = {
  greeting: "hello",
  enableCheckout: true,
  limits: { maxItems: 3 },
};

export const Flags = Vercel.EdgeConfig("Flags", {
  items: { ...FIXTURE_ITEMS },
});
