import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const SKIP_NON_EPHEMRAL_ACCOUNT_TESTS =
  process.env.SKIP_NON_EPHEMRAL_ACCOUNT_TESTS === "1";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider.skipIf(SKIP_NON_EPHEMRAL_ACCOUNT_TESTS)(
  "diag list",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancerMonitor,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
