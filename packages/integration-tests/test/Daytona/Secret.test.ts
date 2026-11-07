import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secrets from "@distilled.cloud/daytona/secret";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

const find = (secretId: string) =>
  secrets.getSecret({ secretId }).pipe(Effect.catchTag("SecretNotFound", () => Effect.undefined));

test.provider(
  "create a secret, update its value, hosts and description in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.Secret("Token", {
          value: Redacted.make("first"),
          description: "test token",
          hosts: ["api.github.com"],
        }),
      );
      expect(created.placeholder).not.toEqual("");
      const observed = yield* secrets.getSecret({ secretId: created.secretId });
      expect(observed.hosts).toEqual(["api.github.com"]);
      expect(observed.description).toEqual("test token");

      const updated = yield* stack.deploy(
        Daytona.Secret("Token", {
          value: Redacted.make("second"),
          description: "rotated",
          hosts: ["api.github.com", "github.com"],
        }),
      );
      expect(updated.secretId).toEqual(created.secretId);
      expect(updated.valueHash).not.toEqual(created.valueHash);
      const after = yield* secrets.getSecret({ secretId: created.secretId });
      expect([...after.hosts].sort()).toEqual(["api.github.com", "github.com"]);
      expect(after.description).toEqual("rotated");

      yield* stack.destroy();
      expect(yield* find(created.secretId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
