import * as AWS from "@/AWS";
import { Alias, Key } from "@/AWS/KMS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as KMS from "@distilled.cloud/aws/kms";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.KMS.Key", () => {
  test.provider(
    "creates, updates, aliases, and schedules deletion",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ManagedKey", {
              description: "alchemy kms smoke v1",
              deletionWindowInDays: 7,
              enableKeyRotation: true,
              tags: {
                Environment: "test",
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
        expect(described.KeyMetadata.KeyUsage).toEqual("ENCRYPT_DECRYPT");
        expect(described.KeyMetadata.KeySpec).toEqual("SYMMETRIC_DEFAULT");
        expect(described.KeyMetadata.Enabled).toEqual(true);

        const rotation = yield* KMS.getKeyRotationStatus({
          KeyId: initial.key.keyId,
        });
        expect(rotation.KeyRotationEnabled).toEqual(true);

        const tags = yield* listTags(initial.key.keyId);
        expect(tags.Environment).toEqual("test");

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

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const key = yield* Key("ManagedKey", {
              deletionWindowInDays: 7,
              description: "alchemy kms smoke v2",
              enableKeyRotation: false,
              enabled: false,
              tags: {
                Environment: "prod",
                Team: "platform",
              },
            });
            const replacementKey = yield* Key("ReplacementKey", {
              deletionWindowInDays: 7,
              description: "alchemy kms replacement",
            });
            const alias = yield* Alias("ManagedAlias", {
              targetKeyId: replacementKey.keyArn,
            });
            return { alias, key, replacementKey };
          }),
        );

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
        yield* assertAliasTarget({
          aliasName: updated.alias.aliasName,
          targetKeyId: updated.replacementKey.keyId,
        });

        yield* stack.destroy();

        yield* assertAliasDeleted(updated.alias.aliasName);
        yield* assertKeyPendingDeletion(updated.key.keyId);
        yield* assertKeyPendingDeletion(updated.replacementKey.keyId);
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
        key.KeyMetadata.Description !== description ||
        key.KeyMetadata.Enabled !== enabled
      ) {
        return yield* Effect.fail(new KeyMetadataNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "KeyMetadataNotConverged",
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
      }),
    );
  });

  const assertKeyPendingDeletion = Effect.fn(function* (keyId: string) {
    yield* KMS.describeKey({ KeyId: keyId }).pipe(
      Effect.flatMap((response) =>
        response.KeyMetadata.KeyState === "PendingDeletion"
          ? Effect.void
          : Effect.fail(new KeyNotPendingDeletion()),
      ),
      Effect.retry({
        while: (error) => error._tag === "KeyNotPendingDeletion",
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
