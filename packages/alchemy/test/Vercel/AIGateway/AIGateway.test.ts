import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as aiGateway from "@distilled.cloud/vercel/ai_gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The AI Gateway routing-rules API (`/v1/ai-gateway/rules`) is documented
// in Vercel's OpenAPI spec but NOT deployed on the live platform: every
// call answers 404 {"code":"not_found","message":"The requested API
// endpoint was not found."} (verified Aug 2026 on the standing Pro team).
// No AIGatewayRule resource is implemented until the endpoint ships — the
// create/update operations don't even carry request bodies in the spec, so
// their wire contract is unknowable. This ungated probe pins the typed
// availability rejection (via the distilled 404 patch) so the day the
// endpoint goes live, this test flips and tells us to build the resource.
test.provider(
  "AI Gateway rules API is not deployed: typed NotFound on list",
  () =>
    Effect.gen(function* () {
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const listed = yield* Effect.result(
        aiGateway.listAiGatewayRules({ teamId }),
      );
      if (Result.isSuccess(listed)) {
        return yield* Effect.die(
          "listAiGatewayRules unexpectedly succeeded — the AI Gateway rules API has shipped; implement Vercel.AIGatewayRule (probe the create/update body contract first)",
        );
      }
      expect(listed.failure._tag).toBe("NotFound");
    }).pipe(logLevel),
);
