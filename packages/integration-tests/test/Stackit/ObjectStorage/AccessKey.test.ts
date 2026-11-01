import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("objectstorage", "accesskey"), timeout: 240_000 } as const;

/** Out-of-band: key ids in a group (`undefined` = the project's default group). */
const keyIdsIn = (projectId: string, region: string, credentialsGroupId: string | undefined) =>
  objectStorage
    .listAccessKeys({ projectId, region, credentials_group: credentialsGroupId })
    .pipe(Effect.map((response) => response.accessKeys.map((key) => key.keyId)));

const waitUntilKeyGone = (
  projectId: string,
  region: string,
  credentialsGroupId: string | undefined,
  keyId: string,
) =>
  keyIdsIn(projectId, region, credentialsGroupId).pipe(
    // A deleted group takes its keys with it.
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    Effect.map((ids) => ids.includes(keyId)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (present) => !present,
      times: 10,
    }),
  );

const keyIn = (expires?: string) =>
  Effect.gen(function* () {
    const group = yield* Stackit.ObjectStorage.CredentialsGroup("KeyGroup", {});
    const key = yield* Stackit.ObjectStorage.AccessKey("Key", {
      credentialsGroupId: group.credentialsGroupId,
      expires,
    });
    return { group, key };
  });

test.provider(
  "create a key in a group, replace it on a new expiry, and delete it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(keyIn());
      const { group, key } = first;

      expect(key.credentialsGroupId).toEqual(group.credentialsGroupId);
      expect(key.projectId).toEqual(projectId);
      expect(key.region).toEqual(region);
      expect(key.expires).toBeUndefined();
      expect(key.accessKeyId.length).toBeGreaterThan(0);
      expect(Redacted.value(key.secretAccessKey).length).toBeGreaterThan(0);
      expect(yield* keyIdsIn(projectId, region, group.credentialsGroupId)).toContain(key.keyId);

      // Redeploying unchanged keeps the key and its secret.
      const plan = yield* stack.plan(keyIn());
      expect(plan.resources.Key).toMatchObject({ action: "noop" });

      const expires = "2099-01-01T00:00:00Z";
      const second = yield* stack.deploy(keyIn(expires));
      expect(second.key.keyId).not.toEqual(key.keyId);
      expect(second.key.expires).toBeDefined();
      expect(new Date(second.key.expires ?? 0).toISOString()).toEqual(
        new Date(expires).toISOString(),
      );
      expect(Redacted.value(second.key.secretAccessKey)).not.toEqual(
        Redacted.value(key.secretAccessKey),
      );
      const ids = yield* keyIdsIn(projectId, region, group.credentialsGroupId);
      expect(ids).toContain(second.key.keyId);
      expect(ids).not.toContain(key.keyId);

      yield* stack.destroy();

      expect(
        yield* waitUntilKeyGone(projectId, region, group.credentialsGroupId, second.key.keyId),
      ).toEqual(false);
    }).pipe(logLevel),
  options,
);

test.provider(
  "moving a key to another group replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployIn = (groupId: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Stackit.ObjectStorage.CredentialsGroup("GroupA", {});
          const b = yield* Stackit.ObjectStorage.CredentialsGroup("GroupB", {});
          const key = yield* Stackit.ObjectStorage.AccessKey("MovedKey", {
            credentialsGroupId: groupId === "A" ? a.credentialsGroupId : b.credentialsGroupId,
          });
          return { a, b, key };
        });

      const first = yield* stack.deploy(deployIn("A"));
      expect(first.key.credentialsGroupId).toEqual(first.a.credentialsGroupId);

      const second = yield* stack.deploy(deployIn("B"));
      expect(second.key.credentialsGroupId).toEqual(second.b.credentialsGroupId);
      expect(second.key.keyId).not.toEqual(first.key.keyId);
      expect(yield* keyIdsIn(projectId, region, second.b.credentialsGroupId)).toContain(
        second.key.keyId,
      );
      expect(
        yield* waitUntilKeyGone(projectId, region, first.a.credentialsGroupId, first.key.keyId),
      ).toEqual(false);

      yield* stack.destroy();

      expect(
        yield* waitUntilKeyGone(projectId, region, second.b.credentialsGroupId, second.key.keyId),
      ).toEqual(false);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a key without a group lands in the project's default group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const key = yield* stack.deploy(Stackit.ObjectStorage.AccessKey("DefaultGroupKey", {}));
      expect(key.credentialsGroupId).toBeUndefined();
      expect(yield* keyIdsIn(projectId, region, undefined)).toContain(key.keyId);

      yield* stack.destroy();

      expect(yield* waitUntilKeyGone(projectId, region, undefined, key.keyId)).toEqual(false);
    }).pipe(logLevel),
  options,
);
