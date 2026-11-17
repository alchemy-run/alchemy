import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secrets from "@distilled.cloud/e2b/secrets";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: E2B.providers() });

const expectSecretGone = (secretId: string) =>
  secrets.getSecret({ secretID: secretId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (exists) => !exists, times: 10 }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

test.provider(
  "create, rotate, update metadata, and delete a secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Secret("Token", {
            value: Redacted.make("first"),
            metadata: { team: "agents" },
          });
        }),
      );
      expect(secret.ref).toBe(`\${e2b.secrets.${secret.name}}`);
      expect(secret.metadata).toEqual({ team: "agents" });
      const created = yield* secrets.getSecret({ secretID: secret.secretId });
      expect(created.metadata["alchemy::id"]).toBe("Token");
      expect(created.metadata.team).toBe("agents");

      // A new value stores a new version of the same secret.
      const rotated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Secret("Token", {
            value: Redacted.make("second"),
            metadata: { team: "agents" },
          });
        }),
      );
      expect(rotated.secretId).toBe(secret.secretId);
      expect(rotated.version).toBeGreaterThan(secret.version);

      // Metadata only: in place, value untouched.
      const relabelled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Secret("Token", {
            value: Redacted.make("second"),
            metadata: { team: "infra" },
          });
        }),
      );
      expect(relabelled.secretId).toBe(secret.secretId);
      const observed = yield* secrets.getSecret({ secretID: secret.secretId });
      expect(observed.metadata.team).toBe("infra");
      expect(observed.metadata["alchemy::id"]).toBe("Token");

      yield* stack.destroy();
      yield* expectSecretGone(secret.secretId);
    }),
  { tags: ["provider:e2b", "provider:e2b:secret", "live"], timeout: 120_000 },
);
