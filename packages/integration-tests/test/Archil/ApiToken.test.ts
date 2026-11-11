import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import { Credentials, controlPlaneUrl } from "@distilled.cloud/archil/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Archil.providers() });

const listed = (tokenId: string) =>
  archil
    .listApiTokens({})
    .pipe(Effect.map(({ data }) => (data.tokens ?? []).find((t) => t.id === tokenId)));

// Archil refuses API keys on its API key operations with the bare 401 a bad
// key gets (typed `Unauthorized`), first from the listing that observes the
// token. Set ARCHIL_TEST_API_TOKEN=1 when ARCHIL_API_KEY is a credential
// Archil accepts there.
test.provider(
  "deploying an API token with an API key is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* Effect.result(stack.deploy(Archil.ApiToken("Ci", {})));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("Unauthorized");
      }
      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:apitoken", "live"], timeout: 60_000 },
);

test.provider.skipIf(!process.env.ARCHIL_TEST_API_TOKEN)(
  "API token is minted, usable on its own, replaced on change, and revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* stack.deploy(Archil.ApiToken("Ci", { description: "first" }));
      expect(Redacted.value(token.token)).toMatch(/^key-/);
      expect((yield* listed(token.tokenId))?.name).toBe(token.name);

      // The minted key works with its own credentials, and sees itself.
      const { data } = yield* archil
        .listApiTokens({})
        .pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({ apiKey: token.token, apiBaseUrl: controlPlaneUrl(token.region)! }),
          ),
        );
      expect((data.tokens ?? []).map((t) => t.id)).toContain(token.tokenId);

      const replaced = yield* stack.deploy(Archil.ApiToken("Ci", { description: "second" }));
      expect(replaced.tokenId).not.toBe(token.tokenId);
      expect(yield* listed(token.tokenId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* listed(replaced.tokenId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:apitoken", "live"], timeout: 120_000 },
);
