import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("iam", "serviceaccountkey"), timeout: 180_000 } as const;

/** Out-of-band: the key, or `undefined` once STACKIT reports it missing. */
const getKey = (projectId: string, serviceAccountEmail: string, keyId: string) =>
  serviceAccount
    .getServiceAccountKey({ projectId, serviceAccountEmail, keyId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitUntilKeyGone = (projectId: string, serviceAccountEmail: string, keyId: string) =>
  getKey(projectId, serviceAccountEmail, keyId).pipe(
    Effect.map((key) => (key === undefined ? "gone" : "present")),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAccountGone = (projectId: string, email: string) =>
  serviceAccount.listServiceAccounts({ projectId }).pipe(
    Effect.map((list) =>
      list.items.some((account) => account.email === email) ? "present" : "gone",
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** No expiry: unset, or STACKIT's year-9999 sentinel. */
const hasNoExpiry = (validUntil: string | undefined) =>
  validUntil === undefined || new Date(validUntil).getUTCFullYear() >= 9999;

const withKey = (props: Omit<Stackit.IAM.ServiceAccountKeyProps, "serviceAccountEmail">) =>
  Effect.gen(function* () {
    const account = yield* Stackit.IAM.ServiceAccount("KeyOwner", {});
    const key = yield* Stackit.IAM.ServiceAccountKey("Key", {
      ...props,
      serviceAccountEmail: account.email,
    });
    return { account, key };
  });

test.provider(
  "create a generated key, deactivate it, set and clear its expiry, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { account, key } = yield* stack.deploy(withKey({}));

      expect(key.serviceAccountEmail).toEqual(account.email);
      expect(key.projectId).toEqual(projectId);
      expect(key.active).toEqual(true);
      expect(key.validUntil).toBeUndefined();
      expect(key.keyOrigin).toEqual("GENERATED");
      expect(key.keyAlgorithm).toEqual("RSA_2048");
      expect(key.credentials.iss).toEqual(account.email);
      expect(key.credentials.sub).toEqual(account.id);
      expect(key.privateKey && Redacted.value(key.privateKey)).toContain("PRIVATE KEY");

      // The key file parses with the same reader Alchemy's profile uses.
      const parsed = yield* Stackit.parseServiceAccountKey(Redacted.value(key.keyJson));
      expect(parsed.id).toEqual(key.keyId);
      expect(parsed.credentials.kid).toEqual(key.credentials.kid);
      expect(parsed.credentials.iss).toEqual(account.email);
      expect(
        parsed.credentials.privateKey && Redacted.value(parsed.credentials.privateKey),
      ).toEqual(key.privateKey && Redacted.value(key.privateKey));

      const observed = yield* getKey(projectId, account.email, key.keyId);
      expect(observed?.id).toEqual(key.keyId);
      expect(observed?.active).toEqual(true);

      // Deactivate in place.
      const inactive = yield* stack.deploy(withKey({ active: false }));
      expect(inactive.key.keyId).toEqual(key.keyId);
      expect(inactive.key.active).toEqual(false);
      expect((yield* getKey(projectId, account.email, key.keyId))?.active).toEqual(false);

      // Set an expiry in place; the key stays inactive.
      const validUntil = "2099-01-01T00:00:00Z";
      const expiring = yield* stack.deploy(withKey({ active: false, validUntil }));
      expect(expiring.key.keyId).toEqual(key.keyId);
      expect(Date.parse(expiring.key.validUntil ?? "")).toEqual(Date.parse(validUntil));
      const expiringObserved = yield* getKey(projectId, account.email, key.keyId);
      expect(Date.parse(expiringObserved?.validUntil ?? "")).toEqual(Date.parse(validUntil));
      expect(expiringObserved?.active).toEqual(false);

      // Clear the expiry and reactivate in place.
      const cleared = yield* stack.deploy(withKey({}));
      expect(cleared.key.keyId).toEqual(key.keyId);
      expect(cleared.key.active).toEqual(true);
      expect(cleared.key.validUntil).toBeUndefined();
      const clearedObserved = yield* getKey(projectId, account.email, key.keyId);
      expect(clearedObserved?.active).toEqual(true);
      expect(hasNoExpiry(clearedObserved?.validUntil)).toEqual(true);

      // The private key survives in-place updates.
      expect(cleared.key.privateKey && Redacted.value(cleared.key.privateKey)).toEqual(
        key.privateKey && Redacted.value(key.privateKey),
      );

      yield* stack.destroy();

      expect(yield* waitUntilAccountGone(projectId, account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "changing the algorithm replaces the key and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(withKey({ algorithm: "RSA_2048" }));
      expect(first.key.keyAlgorithm).toEqual("RSA_2048");

      const plan = yield* stack.plan(withKey({ algorithm: "RSA_4096" }));
      expect(plan.resources.Key).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(withKey({ algorithm: "RSA_4096" }));
      expect(second.account.email).toEqual(first.account.email);
      expect(second.key.keyId).not.toEqual(first.key.keyId);
      expect(second.key.keyAlgorithm).toEqual("RSA_4096");
      expect(second.key.privateKey && Redacted.value(second.key.privateKey)).not.toEqual(
        first.key.privateKey && Redacted.value(first.key.privateKey),
      );
      expect((yield* getKey(projectId, second.account.email, second.key.keyId))?.id).toEqual(
        second.key.keyId,
      );
      expect(yield* waitUntilKeyGone(projectId, first.account.email, first.key.keyId)).toEqual(
        "gone",
      );

      yield* stack.destroy();

      expect(yield* waitUntilAccountGone(projectId, first.account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "removing the key from the stack deletes it and keeps the service account",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { account, key } = yield* stack.deploy(withKey({}));
      expect((yield* getKey(projectId, account.email, key.keyId))?.id).toEqual(key.keyId);

      const remaining = yield* stack.deploy(Stackit.IAM.ServiceAccount("KeyOwner", {}));
      expect(remaining.email).toEqual(account.email);
      expect(yield* waitUntilKeyGone(projectId, account.email, key.keyId)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilAccountGone(projectId, account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
