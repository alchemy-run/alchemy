import * as AWS from "@/AWS";
import { Secret } from "@/AWS/SecretsManager/Secret.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class SecretNotListed extends Data.TaggedError("SecretNotListed") {}

class SecretStillExists extends Data.TaggedError("SecretStillExists") {}

// Secrets Manager marks values as sensitive, so the distilled client can hand
// them back either raw or wrapped in `Redacted` — unwrap for assertions.
const unwrapString = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

// Typed wait-until-gone: the provider deletes with
// `ForceDeleteWithoutRecovery`, which completes asynchronously — poll
// `describeSecret` (bounded) until it fails with the typed
// `ResourceNotFoundException`.
const assertSecretDeleted = (secretArn: string) =>
  secretsmanager.describeSecret({ SecretId: secretArn }).pipe(
    Effect.flatMap(() => Effect.fail(new SecretStillExists())),
    Effect.retry({
      while: (e) => e._tag === "SecretStillExists",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

test.provider("create, update value, destroy", (stack) =>
  Effect.gen(function* () {
    const secret = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("LifecycleSecret", {
          description: "lifecycle v1",
          secretString: Redacted.make("initial-value"),
          tags: { Environment: "test" },
        });
      }),
    );

    expect(secret.secretArn).toContain("arn:aws:secretsmanager:");
    expect(secret.secretName).toBeTruthy();
    expect(secret.versionId).toBeTruthy();

    // Out-of-band verification via distilled.
    const v1 = yield* secretsmanager.getSecretValue({
      SecretId: secret.secretArn,
    });
    expect(unwrapString(v1.SecretString)).toBe("initial-value");

    // Update the value + description in place (no replacement).
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("LifecycleSecret", {
          description: "lifecycle v2",
          secretString: Redacted.make("updated-value"),
          tags: { Environment: "test" },
        });
      }),
    );

    expect(updated.secretArn).toBe(secret.secretArn);
    expect(updated.versionId).toBeTruthy();
    expect(updated.versionId).not.toBe(secret.versionId);

    const v2 = yield* secretsmanager.getSecretValue({
      SecretId: secret.secretArn,
    });
    expect(unwrapString(v2.SecretString)).toBe("updated-value");

    const described = yield* secretsmanager.describeSecret({
      SecretId: secret.secretArn,
    });
    expect(described.Description).toBe("lifecycle v2");

    yield* stack.destroy();

    yield* assertSecretDeleted(secret.secretArn);
  }),
);

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
        schedule: Schedule.exponential(500).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
      }),
    );

    yield* stack.destroy();
  }),
);
