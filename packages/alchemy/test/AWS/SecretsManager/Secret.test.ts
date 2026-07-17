import * as AWS from "@/AWS";
import { Secret } from "@/AWS/SecretsManager/Secret.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class SecretNotListed extends Data.TaggedError("SecretNotListed") {}

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// secret, resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed secret appears in the exhaustively-paginated
// result. `listSecrets` is eventually consistent, so the assertion retries with
// a bounded schedule until the new secret surfaces.
test.provider("list enumerates the deployed secret", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const secret = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("ListSecret", {
          name: "alchemy-test-secret-list",
          description: "list lifecycle op coverage",
          secretString: Redacted.make("super-secret-value"),
          tags: { Environment: "test" },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Secret);

    yield* Effect.gen(function* () {
      const all = yield* provider.list();
      const found = all.find((s) => s.secretArn === secret.secretArn);
      if (!found) {
        return yield* Effect.fail(new SecretNotListed());
      }
      // `list` hydrates the exact `read` Attributes shape (no plaintext value).
      expect(found.secretName).toBe(secret.secretName);
      expect(found.versionId).toBeUndefined();
      expect(found.tags.Environment).toBe("test");
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "SecretNotListed",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
    );

    yield* stack.destroy();
  }),
);
