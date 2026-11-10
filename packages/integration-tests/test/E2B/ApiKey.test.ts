import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/e2b/api_keys";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: E2B.providers() });

const keyExists = (apiKeyId: string) =>
  apiKeys.listApiKeys({}).pipe(Effect.map((all) => all.some((key) => key.id === apiKeyId)));

// API keys are managed with a personal access token (E2B_ACCESS_TOKEN +
// E2B_TEAM_ID in the testing profile), not an API key.
test.provider(
  "create, rename, use, and delete an API key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.ApiKey("Ci", {});
        }),
      );
      expect(Redacted.value(key.key)).toMatch(/^e2b_/);
      expect(yield* keyExists(key.apiKeyId)).toBe(true);

      // The new key authenticates control-plane calls on its own: a wrong key
      // fails this call with Unauthorized.
      const listed = yield* sandboxes
        .listSandboxes({})
        .pipe(Effect.provide(E2B.credentials({ apiKey: key.key })));
      expect(Array.isArray(listed.items)).toBe(true);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.ApiKey("Ci", { name: `${key.name}-renamed` });
        }),
      );
      expect(renamed.apiKeyId).toBe(key.apiKeyId);
      expect(renamed.name).toBe(`${key.name}-renamed`);
      expect(Redacted.value(renamed.key)).toBe(Redacted.value(key.key));

      yield* stack.destroy();
      expect(yield* keyExists(key.apiKeyId)).toBe(false);
    }),
  { tags: ["provider:e2b", "provider:e2b:api-key", "live"], timeout: 120_000 },
);
