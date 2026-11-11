import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as webhook from "@distilled.cloud/modal/webhook";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Modal.providers() });

const listed = (tokenId: string) =>
  webhook
    .listWebhookToken({})
    .pipe(Effect.map(({ tokens }) => (tokens ?? []).find((t) => t.tokenId === tokenId)));

test.provider(
  "create, rename, scope, and delete a webhook token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { token, env } = yield* stack.deploy(
        Effect.gen(function* () {
          const env = yield* Modal.Environment("TokenEnv", {});
          const token = yield* Modal.WebhookToken("Token", { scoped: true, environments: [env] });
          return { token, env };
        }),
      );
      expect(Redacted.value(token.tokenSecret)).toMatch(/^ws-/);
      expect((yield* listed(token.tokenId))?.scoped).toBe(true);
      const { tokens } = yield* webhook.webhookTokenListForEnvironment({
        environmentName: env.name,
      });
      expect((tokens ?? []).map((t) => t.tokenId)).toContain(token.tokenId);
      const { tokens: inMain } = yield* webhook.webhookTokenListForEnvironment({
        environmentName: "main",
      });
      expect((inMain ?? []).map((t) => t.tokenId)).not.toContain(token.tokenId);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const env = yield* Modal.Environment("TokenEnv", {});
          return yield* Modal.WebhookToken("Token", {
            name: "alchemy-renamed",
            scoped: true,
            environments: [env],
          });
        }),
      );
      expect(renamed.tokenId).toBe(token.tokenId);
      expect((yield* listed(token.tokenId))?.name).toBe("alchemy-renamed");

      yield* stack.destroy();
      expect(yield* listed(token.tokenId)).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:webhook", "live"], timeout: 120_000 },
);
