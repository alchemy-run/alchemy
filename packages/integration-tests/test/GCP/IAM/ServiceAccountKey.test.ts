import * as GCP from "@alchemy.run/gcp";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// New keys read inconsistently for a few seconds after create — as 404, or
// as a 403 "Permission iam.serviceAccountKeys.get is required".
const getKey = (name: string) =>
  iam.getProjectsServiceAccountsKeys({ name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound" || error._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const waitUntilGone = (name: string) =>
  iam.getProjectsServiceAccountsKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

const keyFor = (account: "A" | "B") =>
  Effect.gen(function* () {
    const a = yield* GCP.IAM.ServiceAccount("KeyOwnerA", {});
    const b = yield* GCP.IAM.ServiceAccount("KeyOwnerB", {});
    const key = yield* GCP.IAM.ServiceAccountKey("Key", {
      serviceAccount: account === "A" ? a.email : b.email,
    });
    return { a: a.email, b: b.email, key };
  });

test.provider(
  "create, keep, replace, and delete a service account key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(keyFor("A"));
      expect(created.key.serviceAccount).toEqual(created.a);
      expect(created.key.name).toMatch(
        new RegExp(
          `^projects/[^/]+/serviceAccounts/${created.a}/keys/${created.key.privateKeyId}$`,
        ),
      );
      expect(Redacted.value(created.key.privateKey)).toMatch(/^-----BEGIN PRIVATE KEY-----/);

      const fetched = yield* getKey(created.key.name);
      expect(fetched.name).toEqual(created.key.name);

      // The private half is only returned on create: a redeploy keeps the key.
      const kept = yield* stack.deploy(keyFor("A"));
      expect(kept.key.name).toEqual(created.key.name);

      // Moving the key to another account replaces it.
      const replaced = yield* stack.deploy(keyFor("B"));
      expect(replaced.key.serviceAccount).toEqual(replaced.b);
      expect(replaced.key.name).not.toEqual(created.key.name);
      yield* getKey(replaced.key.name);
      expect(yield* waitUntilGone(created.key.name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(replaced.key.name)).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
