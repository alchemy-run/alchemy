import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import { appRoleVaultCredentials, VaultCredentials } from "@distilled.cloud/stackit/Vault";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("secretsmanager", "approlesecretid"),
  timeout: 300_000,
} as const;

const Vault = Stackit.SecretsManager.Instance("SecretIdInstance", { acls: ["0.0.0.0/0"] });

test.provider(
  "create, update, rotate and delete a secret id",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (props: { description?: string; rotationKey?: string }) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const role = yield* Stackit.SecretsManager.AppRole("SecretIdRole", {
            instanceId: vault.instanceId,
          });
          const secretId = yield* Stackit.SecretsManager.AppRoleSecretId("BasicSecretId", {
            instanceId: vault.instanceId,
            roleId: role.roleId,
            ...props,
          });
          return { vault, role, secretId };
        });

      const {
        vault,
        role,
        secretId: created,
      } = yield* stack.deploy(program({ description: "first" }));
      const at = { projectId, instanceId: vault.instanceId, roleId: role.roleId };

      expect(created.version).toEqual(expect.any(Number));
      expect(created.description).toEqual("first");
      const value = Redacted.value(created.secretId!);
      expect(value.length).toBeGreaterThan(0);

      // The role id and secret id log in to the instance's Vault API.
      const client = yield* HttpClient.HttpClient;
      const listed = yield* kv.listRootSecrets({ mount: vault.instanceId, list: "true" }).pipe(
        Effect.provideService(
          VaultCredentials,
          appRoleVaultCredentials({
            apiUrl: vault.apiUrl,
            roleId: role.roleId,
            secretId: created.secretId!,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ),
        // An empty engine lists as a 404: the login itself succeeded.
        Effect.catchTag("NotFound", () => Effect.succeed("empty" as const)),
      );
      expect(listed).toEqual("empty");

      // An update keeps the version and the value.
      const { secretId: updated } = yield* stack.deploy(program({ description: "second" }));
      expect(updated.version).toEqual(created.version);
      expect(Redacted.value(updated.secretId!)).toEqual(value);
      const fetched = yield* secretsManager.getApproleSecretId({
        ...at,
        secretIdVersion: created.version,
      });
      expect(fetched.description).toEqual("second");

      // A new rotation key replaces it, and the old one goes away.
      const { secretId: rotated } = yield* stack.deploy(
        program({ description: "second", rotationKey: "2" }),
      );
      expect(rotated.version).not.toEqual(created.version);
      expect(Redacted.value(rotated.secretId!)).not.toEqual(value);
      const { secretIds } = yield* secretsManager.listApproleSecretIds(at);
      expect(secretIds.map((secretId) => secretId.version)).toEqual([rotated.version]);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a secret id STACKIT stopped returning is recreated by the next deploy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const vault = yield* Vault;
        const role = yield* Stackit.SecretsManager.AppRole("ExpiringRole", {
          instanceId: vault.instanceId,
        });
        const secretId = yield* Stackit.SecretsManager.AppRoleSecretId("ExpiringSecretId", {
          instanceId: vault.instanceId,
          roleId: role.roleId,
        });
        return { vault, role, secretId };
      });

      const { vault, role, secretId: created } = yield* stack.deploy(program);
      const at = { projectId, instanceId: vault.instanceId, roleId: role.roleId };

      const unchanged = yield* stack.plan(program);
      expect(unchanged.resources.ExpiringSecretId).toMatchObject({ action: "noop" });

      // An expired secret id looks the same from here as a deleted one: it's gone.
      yield* secretsManager.deleteApproleSecretId({ ...at, secretIdVersion: created.version });

      const plan = yield* stack.plan(program);
      expect(plan.resources.ExpiringSecretId).toMatchObject({ action: "update" });

      const { secretId: renewed } = yield* stack.deploy(program);
      expect(renewed.version).not.toEqual(created.version);
      expect(Redacted.value(renewed.secretId!)).not.toEqual(Redacted.value(created.secretId!));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a description the resource once set never claims someone else's secret id",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (description: string | undefined) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const role = yield* Stackit.SecretsManager.AppRole("ClaimRole", {
            instanceId: vault.instanceId,
          });
          const secretId = yield* Stackit.SecretsManager.AppRoleSecretId("ClaimSecretId", {
            instanceId: vault.instanceId,
            roleId: role.roleId,
            description,
          });
          return { vault, role, secretId };
        });

      const description = "alchemy-test-on-call";
      const { vault, role, secretId: created } = yield* stack.deploy(program(description));
      const at = { projectId, instanceId: vault.instanceId, roleId: role.roleId };

      // Deleted out of band, and someone else's now has that description.
      yield* secretsManager.deleteApproleSecretId({ ...at, secretIdVersion: created.version });
      const foreign = yield* secretsManager.createApproleSecretId({ ...at, description });

      const { secretId: recreated } = yield* stack.deploy(program(undefined));
      expect(recreated.version).not.toEqual(foreign.version);
      const { secretIds } = yield* secretsManager.listApproleSecretIds(at);
      expect(secretIds.map((secretId) => secretId.version)).toContain(foreign.version);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
