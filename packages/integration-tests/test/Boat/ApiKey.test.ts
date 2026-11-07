import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import { fromApiKey } from "@distilled.cloud/boat-dev/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:api-key", "live"];

const listed = (apiKeyId: string) =>
  boat.listApiKeys({}).pipe(Effect.map((r) => r.apiKeys.find((key) => key.id === apiKeyId)));

test.provider(
  "mint a scoped key that works only on its sandbox, replace it on a new scope, and revoke it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (actions: Boat.ApiKeyAction[]) =>
        Effect.gen(function* () {
          const box = yield* Boat.Sandbox("KeyBox", {
            type: "small",
            noEnv: true,
            autoStop: "10 minutes",
          });
          const key = yield* Boat.ApiKey("Scoped", {
            actions,
            sandboxIds: [box.sandboxId],
            ttl: "1d",
          });
          return { box, key };
        });

      const { box, key } = yield* stack.deploy(program(["sandbox.read", "exec"]));
      expect(Redacted.value(key.key)).toMatch(/^boat_/);
      expect(Redacted.value(key.key).endsWith(key.keyLastFour)).toBe(true);
      expect((yield* listed(key.apiKeyId))?.scope?.actions).toEqual(["sandbox.read", "exec"]);

      // The key runs commands in its sandbox and can't create sandboxes.
      const asKey = fromApiKey({ apiKey: key.key });
      const ran = yield* boat
        .executeSandboxCommand({ sandboxId: box.sandboxId, command: "echo scoped" })
        .pipe(Effect.provide(asKey));
      expect("stdout" in ran ? ran.stdout.trim() : undefined).toBe("scoped");
      const denied = yield* boat
        .createSandbox({ type: "small", noEnv: true })
        .pipe(Effect.provide(asKey), Effect.flip);
      expect(denied._tag).toBe("Forbidden");

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(program(["sandbox.read", "exec"]));
      expect(plan.resources.Scoped.action).toBe("noop");

      // A new scope is a new key; the old one is revoked.
      const next = yield* stack.deploy(program(["sandbox.read", "exec", "file.read"]));
      expect(next.key.apiKeyId).not.toBe(key.apiKeyId);
      expect(yield* listed(key.apiKeyId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* listed(next.key.apiKeyId)).toBeUndefined();
    }),
  { tags, timeout: 180_000 },
);
