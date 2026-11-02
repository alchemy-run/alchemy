import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { readSecretMetadata, readSecretValues, withVault } from "./vault.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("secretsmanager", "secret"), timeout: 300_000 } as const;

const Vault = Stackit.SecretsManager.Instance("SecretInstance", { acls: ["0.0.0.0/0"] });

const FIRST_VALUE = "first-value-of-the-secret";
const SECOND_VALUE = "second-value-of-the-secret";

test.provider(
  "create, update, move and delete a secret",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (props: { path?: string; value: string; maxVersions?: number }) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const secret = yield* Stackit.SecretsManager.Secret("BasicSecret", {
            instanceId: vault.instanceId,
            path: props.path,
            data: { apiKey: Redacted.make(props.value) },
            maxVersions: props.maxVersions,
          });
          return { vault, secret };
        });

      const { vault, secret: created } = yield* stack.deploy(
        program({ path: "alchemy-test/basic", value: FIRST_VALUE }),
      );
      const instanceId = vault.instanceId;
      const location = { projectId, instanceId, apiUrl: vault.apiUrl };

      expect(created.path).toEqual("alchemy-test/basic");
      expect(created.version).toEqual(1);
      expect(created.keys).toEqual(["apiKey"]);
      // The value isn't in the attributes, which are what state keeps of a secret
      // beyond its props.
      expect(JSON.stringify(created)).not.toContain(FIRST_VALUE);

      // Out of band: the value landed, under a path holding a `/`, with the
      // ownership markers in its custom metadata.
      const firstRead = yield* withVault(
        location,
        Effect.all({
          values: readSecretValues(instanceId, created.path),
          metadata: readSecretMetadata(instanceId, created.path),
        }),
      );
      expect(firstRead.values).toEqual({ apiKey: FIRST_VALUE });
      expect(firstRead.metadata).toMatchObject({
        custom_metadata: { "alchemy.id": "BasicSecret" },
      });

      // Redeploying unchanged writes no new version.
      const { secret: again } = yield* stack.deploy(
        program({ path: "alchemy-test/basic", value: FIRST_VALUE }),
      );
      expect(again.version).toEqual(1);

      // A new value is a new version, and the old one stays readable.
      const { secret: updated } = yield* stack.deploy(
        program({ path: "alchemy-test/basic", value: SECOND_VALUE, maxVersions: 5 }),
      );
      expect(updated.version).toEqual(2);
      const secondRead = yield* withVault(
        location,
        Effect.all({
          values: readSecretValues(instanceId, created.path),
          first: kv.getSecret({ mount: instanceId, secretPath: created.path, version: 1 }),
          metadata: readSecretMetadata(instanceId, created.path),
        }),
      );
      expect(secondRead.values).toEqual({ apiKey: SECOND_VALUE });
      expect(secondRead.first.data.metadata.version).toEqual(1);
      expect(secondRead.metadata).toMatchObject({ max_versions: 5, current_version: 2 });

      // A value changed out of band is put back by the next change that deploys.
      yield* withVault(
        location,
        kv.putSecret({
          mount: instanceId,
          secretPath: created.path,
          data: { apiKey: "out-of-band" },
        }),
      );
      const { secret: restored } = yield* stack.deploy(
        program({ path: "alchemy-test/basic", value: SECOND_VALUE, maxVersions: 4 }),
      );
      expect(restored.version).toEqual(4);
      expect(yield* withVault(location, readSecretValues(instanceId, created.path))).toEqual({
        apiKey: SECOND_VALUE,
      });

      // A new path replaces the secret, writing the new path first: the old one
      // is only destroyed once its replacement exists.
      const movePlan = yield* stack.plan(
        program({ path: "alchemy-test/moved", value: SECOND_VALUE }),
      );
      expect(movePlan.resources.BasicSecret).toMatchObject({
        action: "replace",
        deleteFirst: false,
      });

      // The old path is gone with its versions afterwards.
      const { secret: moved } = yield* stack.deploy(
        program({ path: "alchemy-test/moved", value: SECOND_VALUE }),
      );
      expect(moved.path).toEqual("alchemy-test/moved");
      expect(moved.version).toEqual(1);
      const thirdRead = yield* withVault(
        location,
        Effect.all({
          moved: readSecretValues(instanceId, moved.path),
          oldMetadata: readSecretMetadata(instanceId, created.path),
        }),
      );
      expect(thirdRead.moved).toEqual({ apiKey: SECOND_VALUE });
      expect(thirdRead.oldMetadata).toEqual("gone");

      // A deploy's short-lived AppRole never outlives the deploy.
      const { approles } = yield* secretsManager.listApproles({ projectId, instanceId });
      expect(approles.filter((role) => role.description.startsWith("alchemy-deploy-"))).toEqual([]);

      // Removing the secret permanently deletes it, and the instance stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          const live = yield* Vault;
          return { live };
        }),
      );
      expect(yield* withVault(location, readSecretMetadata(instanceId, moved.path))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a generated path is stable, and a foreign secret is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const vault = yield* stack.deploy(Vault);
      const location = { projectId, instanceId: vault.instanceId, apiUrl: vault.apiUrl };

      const generated = (value: string) =>
        Effect.gen(function* () {
          const live = yield* Vault;
          return yield* Stackit.SecretsManager.Secret("GeneratedPath", {
            instanceId: live.instanceId,
            data: { apiKey: Redacted.make(value) },
          });
        });
      const first = yield* stack.deploy(generated(FIRST_VALUE));
      expect(first.path).toMatch(/^[a-z0-9-]+$/);
      const second = yield* stack.deploy(generated(SECOND_VALUE));
      expect(second.path).toEqual(first.path);
      expect(second.version).toEqual(2);

      // A secret at this path written by someone else has no ownership markers.
      const foreignPath = "alchemy-test/foreign";
      yield* withVault(
        location,
        kv.putSecret({
          mount: vault.instanceId,
          secretPath: foreignPath,
          data: { theirs: "theirs" },
        }),
      );
      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            const live = yield* Vault;
            return yield* Stackit.SecretsManager.Secret("ForeignSecret", {
              instanceId: live.instanceId,
              path: foreignPath,
              data: { apiKey: Redacted.make(FIRST_VALUE) },
            });
          }),
        )
        .pipe(Effect.exit);
      expect(exit._tag).toEqual("Failure");
      expect(yield* withVault(location, readSecretValues(vault.instanceId, foreignPath))).toEqual({
        theirs: "theirs",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
