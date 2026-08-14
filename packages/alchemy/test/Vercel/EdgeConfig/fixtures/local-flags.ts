/**
 * Shared Edge Config declaration for the dev-mode (`alchemy dev`) suite —
 * yielded by BOTH the local Function fixture (to bind it) and the test's
 * deploy program (to read its attributes); registration is FQN-idempotent.
 */
import * as Vercel from "@/Vercel/index.ts";

/** The declarative item set under test (asserted by the test). */
export const LOCAL_FIXTURE_ITEMS = {
  greeting: "local-hello",
  enableCheckout: true,
  limits: { maxItems: 3 },
};

export const LocalFlags = Vercel.EdgeConfig("LocalFlags", {
  items: { ...LOCAL_FIXTURE_ITEMS },
});
