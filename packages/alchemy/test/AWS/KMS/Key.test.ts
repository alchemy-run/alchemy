import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Alias, Key } from "@/AWS/KMS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as KMS from "@distilled.cloud/aws/kms";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.KMS.Key", () => {
  test.provider(
    "reconciles mutable key settings across updates without replacement",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { accountId } = yield* AWSEnvironment.current;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ManagedKey", {
              description: "alchemy kms smoke v1",
              deletionWindowInDays: 7,
              enableKeyRotation: true,
              tags: {
                Environment: "test",
                Owner: "alice",
              },
            });
            const alias = yield* Alias("ManagedAlias", {
              targetKeyId: key.keyId,
            });
            return { alias, key };
          }),
        );

        const described = yield* KMS.describeKey({
          KeyId: initial.key.keyId,
        });
        expect(described.KeyMetadata!.KeyUsage).toEqual("ENCRYPT_DECRYPT");
        expect(described.KeyMetadata!.KeySpec).toEqual("SYMMETRIC_DEFAULT");
        expect(described.KeyMetadata!.Enabled).toEqual(true);

        const rotation = yield* KMS.getKeyRotationStatus({
          KeyId: initial.key.keyId,
        });
        expect(rotation.KeyRotationEnabled).toEqual(true);

        const initialTags = yield* listTags(initial.key.keyId);
        expect(initialTags.Environment).toEqual("test");
        expect(initialTags.Owner).toEqual("alice");

        const aliasState = yield* getAlias(initial.alias.aliasName);
        expect(aliasState?.TargetKeyId).toEqual(initial.key.keyId);

        const keyProvider = yield* Provider.findProvider(Key);
        const aliasProvider = yield* Provider.findProvider(Alias);
        yield* assertProvidersListResources({
          aliasName: initial.alias.aliasName,
          aliasProvider,
          keyId: initial.key.keyId,
          keyProvider,
        });

        const policy = JSON.stringify({
          Version: "2012-10-17",
          Id: "alchemy-test-policy",
          Statement: [
            {
              Sid: "EnableRootPermissions",
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${accountId}:root` },
              Action: "kms:*",
              Resource: "*",
            },
          ],
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ManagedKey", {
              deletionWindowInDays: 7,
              description: "alchemy kms smoke v2",
              enableKeyRotation: false,
              enabled: false,
              bypassPolicyLockoutSafetyCheck: true,
              policy,
              tags: {
                Environment: "prod",
                Team: "platform",
              },
            });
            const alias = yield* Alias("ManagedAlias", {
              targetKeyId: key.keyId,
            });
            return { alias, key };
          }),
        );

        // No replacement: a settings-only update keeps the same physical key.
        expect(updated.key.keyId).toEqual(initial.key.keyId);

        yield* assertKeyMetadata({
          description: "alchemy kms smoke v2",
          enabled: false,
          keyId: updated.key.keyId,
        });
        yield* assertKeyTags({
          keyId: updated.key.keyId,
          tags: {
            Environment: "prod",
            Team: "platform",
          },
        });

        // The removed `Owner` tag must no longer be present (untag path).
        const updatedTags = yield* listTags(updated.key.keyId);
        expect(updatedTags.Owner).toBeUndefined();

        // Rotation must be disabled after the update.
        const updatedRotation = yield* KMS.getKeyRotationStatus({
          KeyId: updated.key.keyId,
        });
        expect(updatedRotation.KeyRotationEnabled).toEqual(false);

        // The inline policy must have been applied.
        const appliedPolicy = yield* KMS.getKeyPolicy({
          KeyId: updated.key.keyId,
          PolicyName: "default",
        });
        expect(appliedPolicy.Policy).toContain("alchemy-test-policy");

        yield* stack.destroy();

        yield* assertAliasDeleted(updated.alias.aliasName);
        yield* assertKeyPendingDeletion(updated.key.keyId);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "replaces the key when keySpec changes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Set keySpec explicitly so the diff against the next deploy is
        // well-defined. The physical key may be adopted from a prior run's
        // pending-deletion key (KMS keys can't be hard-deleted), so we don't
        // assert its keySpec here — only the replacement behavior below.
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ReplaceKey", {
              description: "alchemy kms replace v1",
              deletionWindowInDays: 7,
              keySpec: "SYMMETRIC_DEFAULT",
              keyUsage: "ENCRYPT_DECRYPT",
            });
            return { key };
          }),
        );

        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ReplaceKey", {
              description: "alchemy kms replace v2",
              deletionWindowInDays: 7,
              keySpec: "RSA_2048",
              keyUsage: "ENCRYPT_DECRYPT",
            });
            return { key };
          }),
        );

        // A keySpec change forces a replacement: a brand-new physical key.
        expect(replaced.key.keyId).not.toEqual(initial.key.keyId);

        const replacedDescribe = yield* KMS.describeKey({
          KeyId: replaced.key.keyId,
        });
        expect(replacedDescribe.KeyMetadata!.KeySpec).toEqual("RSA_2048");

        // The old key must have been scheduled for deletion by the replacement.
        yield* assertKeyPendingDeletion(initial.key.keyId);

        yield* stack.destroy();

        yield* assertKeyPendingDeletion(replaced.key.keyId);
      }),
    { timeout: 180_000 },
  );

  const aliasNameA = "alias/alchemy-test-kms-rename-a" as const;
  const aliasNameB = "alias/alchemy-test-kms-rename-b" as const;

  test.provider(
    "retargets an alias in place, then replaces it on rename",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const keyA = yield* Key("AliasKeyA", {
              description: "alchemy kms alias target A",
              deletionWindowInDays: 7,
            });
            const keyB = yield* Key("AliasKeyB", {
              description: "alchemy kms alias target B",
              deletionWindowInDays: 7,
            });
            const alias = yield* Alias("RenamableAlias", {
              aliasName: aliasNameA,
              targetKeyId: keyA.keyId,
            });
            return { alias, keyA, keyB };
          }),
        );

        expect(initial.alias.aliasName).toEqual(aliasNameA);
        yield* assertAliasTarget({
          aliasName: aliasNameA,
          targetKeyId: initial.keyA.keyId,
        });

        // Retarget the alias to key B. Same alias name => updateAlias, no replace.
        const retargeted = yield* stack.deploy(
          Effect.gen(function* () {
            const keyA = yield* Key("AliasKeyA", {
              description: "alchemy kms alias target A",
              deletionWindowInDays: 7,
            });
            const keyB = yield* Key("AliasKeyB", {
              description: "alchemy kms alias target B",
              deletionWindowInDays: 7,
            });
            const alias = yield* Alias("RenamableAlias", {
              aliasName: aliasNameA,
              targetKeyId: keyB.keyId,
            });
            return { alias, keyA, keyB };
          }),
        );

        expect(retargeted.alias.aliasName).toEqual(aliasNameA);
        yield* assertAliasTarget({
          aliasName: aliasNameA,
          targetKeyId: retargeted.keyB.keyId,
        });

        // Rename the alias. A name change forces a replacement: a new alias is
        // created and the old one is deleted.
        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            const keyA = yield* Key("AliasKeyA", {
              description: "alchemy kms alias target A",
              deletionWindowInDays: 7,
            });
            const keyB = yield* Key("AliasKeyB", {
              description: "alchemy kms alias target B",
              deletionWindowInDays: 7,
            });
            const alias = yield* Alias("RenamableAlias", {
              aliasName: aliasNameB,
              targetKeyId: keyB.keyId,
            });
            return { alias, keyA, keyB };
          }),
        );

        expect(renamed.alias.aliasName).toEqual(aliasNameB);
        yield* assertAliasTarget({
          aliasName: aliasNameB,
          targetKeyId: renamed.keyB.keyId,
        });
        yield* assertAliasDeleted(aliasNameA);

        yield* stack.destroy();

        yield* assertAliasDeleted(aliasNameB);
      }),
    { timeout: 180_000 },
  );

  class AliasStillExists extends Data.TaggedError("AliasStillExists") {}
  class KeyNotPendingDeletion extends Data.TaggedError(
    "KeyNotPendingDeletion",
  ) {}
  class ProviderListNotConverged extends Data.TaggedError(
    "ProviderListNotConverged",
  ) {}
  class KeyMetadataNotConverged extends Data.TaggedError(
    "KeyMetadataNotConverged",
  ) {}
  class KeyTagsNotConverged extends Data.TaggedError("KeyTagsNotConverged") {}
  class AliasTargetNotConverged extends Data.TaggedError(
    "AliasTargetNotConverged",
  ) {}

  const assertKeyMetadata = Effect.fn(function* ({
    description,
    enabled,
    keyId,
  }: {
    description: string;
    enabled: boolean;
    keyId: string;
  }) {
    yield* Effect.gen(function* () {
      const key = yield* KMS.describeKey({ KeyId: keyId });
      if (
        key.KeyMetadata!.Description !== description ||
        key.KeyMetadata!.Enabled !== enabled
      ) {
        return yield* Effect.fail(new KeyMetadataNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "KeyMetadataNotConverged",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const assertKeyTags = Effect.fn(function* ({
    keyId,
    tags,
  }: {
    keyId: string;
    tags: Record<string, string>;
  }) {
    yield* Effect.gen(function* () {
      const observed = yield* listTags(keyId);
      if (
        !Object.entries(tags).every(([name, value]) => observed[name] === value)
      ) {
        return yield* Effect.fail(new KeyTagsNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "KeyTagsNotConverged",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const assertAliasTarget = Effect.fn(function* ({
    aliasName,
    targetKeyId,
  }: {
    aliasName: string;
    targetKeyId: string;
  }) {
    yield* Effect.gen(function* () {
      const alias = yield* getAlias(aliasName);
      if (alias?.TargetKeyId !== targetKeyId) {
        return yield* Effect.fail(new AliasTargetNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "AliasTargetNotConverged",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const assertProvidersListResources = Effect.fn(function* ({
    aliasName,
    aliasProvider,
    keyId,
    keyProvider,
  }: {
    aliasName: string;
    aliasProvider: Provider.ProviderService<Alias>;
    keyId: string;
    keyProvider: Provider.ProviderService<Key>;
  }) {
    yield* Effect.gen(function* () {
      const [listedKeys, listedAliases] = yield* Effect.all(
        [keyProvider.list(), aliasProvider.list()],
        { concurrency: "unbounded" },
      );
      if (!listedKeys.some((key) => key.keyId === keyId)) {
        return yield* Effect.fail(new ProviderListNotConverged());
      }
      if (!listedAliases.some((alias) => alias.aliasName === aliasName)) {
        return yield* Effect.fail(new ProviderListNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "ProviderListNotConverged",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const assertAliasDeleted = Effect.fn(function* (aliasName: string) {
    yield* Effect.gen(function* () {
      const alias = yield* getAlias(aliasName);
      if (alias !== undefined) {
        return yield* Effect.fail(new AliasStillExists());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "AliasStillExists",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const assertKeyPendingDeletion = Effect.fn(function* (keyId: string) {
    yield* KMS.describeKey({ KeyId: keyId }).pipe(
      Effect.flatMap((response) =>
        response.KeyMetadata!.KeyState === "PendingDeletion"
          ? Effect.void
          : Effect.fail(new KeyNotPendingDeletion()),
      ),
      Effect.retry({
        while: (error) => error._tag === "KeyNotPendingDeletion",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(8)]),
      }),
    );
  });

  const getAlias = Effect.fn(function* (aliasName: string) {
    const aliases = yield* KMS.listAliases.pages({}).pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Aliases ?? []),
      ),
    );

    return aliases.find((alias) => alias.AliasName === aliasName);
  });

  const listTags = Effect.fn(function* (keyId: string) {
    const tags = yield* KMS.listResourceTags.pages({ KeyId: keyId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Tags ?? []),
      ),
    );

    return Object.fromEntries(tags.map((tag) => [tag.TagKey, tag.TagValue]));
  });
});
