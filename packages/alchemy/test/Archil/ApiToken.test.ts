import * as Archil from "@/Archil";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Archil.providers() });

const hasArchil = !!process.env.ARCHIL_API_KEY;

test.provider.skipIf(!hasArchil)(
  "create and delete an API token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.ApiToken("TestToken", {
            description: "alchemy live test token",
          });
        }),
      );

      expect(token.tokenId).toBeTruthy();
      expect(token.name).toBeTruthy();
      // The plaintext value is captured exactly once at creation.
      expect(Redacted.value(token.value).length).toBeGreaterThan(0);

      const listed = yield* Archil.listApiTokens({ region: token.region });
      expect(listed.find((t) => t.id === token.tokenId)).toBeDefined();

      // Idempotent re-deploy keeps identity and the captured value.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.ApiToken("TestToken", {
            description: "alchemy live test token",
          });
        }),
      );
      expect(again.tokenId).toBe(token.tokenId);
      expect(Redacted.value(again.value)).toBe(Redacted.value(token.value));

      yield* stack.destroy();

      const after = yield* Archil.listApiTokens({ region: token.region });
      expect(after.find((t) => t.id === token.tokenId)).toBeUndefined();
    }),
  { timeout: 120_000 },
);
