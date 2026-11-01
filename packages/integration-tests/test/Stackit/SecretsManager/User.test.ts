import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import { userpassVaultCredentials, VaultCredentials } from "@distilled.cloud/stackit/Vault";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("secretsmanager", "user"), timeout: 300_000 } as const;

/** The users of an instance, out of band. */
const liveUsers = (projectId: string, instanceId: string) =>
  secretsManager.listUsers({ projectId, instanceId }).pipe(Effect.map(({ users }) => users));

const Vault = Stackit.SecretsManager.Instance("UserInstance", { acls: ["0.0.0.0/0"] });

test.provider(
  "create, update, rotate and delete a user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (props: { description?: string; write?: boolean; rotationKey?: string }) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const user = yield* Stackit.SecretsManager.User("BasicUser", {
            instanceId: vault.instanceId,
            ...props,
          });
          return { vault, user };
        });

      const { vault, user: created } = yield* stack.deploy(program({ description: "reader" }));
      const instanceId = vault.instanceId;

      expect(created.username.length).toBeGreaterThan(0);
      expect(created.write).toEqual(false);
      expect(created.description).toEqual("reader");
      const password = Redacted.value(created.password!);
      expect(password.length).toBeGreaterThan(0);

      // The login works against the instance's Vault API.
      const client = yield* HttpClient.HttpClient;
      const listed = yield* kv.listRootSecrets({ mount: instanceId, list: "true" }).pipe(
        Effect.provideService(
          VaultCredentials,
          userpassVaultCredentials({
            apiUrl: vault.apiUrl,
            username: created.username,
            password: created.password!,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ),
        // An empty engine lists as a 404: the login itself succeeded.
        Effect.catchTag("NotFound", () => Effect.succeed("empty" as const)),
      );
      expect(listed).toEqual("empty");

      // An update keeps the user and its password.
      const { user: updated } = yield* stack.deploy(
        program({ description: "writer", write: true }),
      );
      expect(updated.userId).toEqual(created.userId);
      expect(updated.username).toEqual(created.username);
      expect(Redacted.value(updated.password!)).toEqual(password);

      const fetched = yield* secretsManager.getUser({
        projectId,
        instanceId,
        userId: created.userId,
      });
      expect(fetched.description).toEqual("writer");
      expect(fetched.write).toEqual(true);

      // A new rotation key replaces the user, and the old one goes away.
      const { user: rotated } = yield* stack.deploy(
        program({ description: "writer", write: true, rotationKey: "2" }),
      );
      expect(rotated.userId).not.toEqual(created.userId);
      expect(Redacted.value(rotated.password!)).not.toEqual(password);
      expect((yield* liveUsers(projectId, instanceId)).map((user) => user.id)).toEqual([
        rotated.userId,
      ]);

      yield* stack.deploy(
        Effect.gen(function* () {
          const live = yield* Vault;
          return { live };
        }),
      );
      expect(yield* liveUsers(projectId, instanceId)).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a description the resource once set never claims someone else's user",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (description: string | undefined) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const user = yield* Stackit.SecretsManager.User("ClaimUser", {
            instanceId: vault.instanceId,
            description,
          });
          return { vault, user };
        });

      const description = "alchemy-test-on-call";
      const { vault, user: created } = yield* stack.deploy(program(description));
      const instanceId = vault.instanceId;

      // Deleted out of band, and someone else's now has that description.
      yield* secretsManager.deleteUser({ projectId, instanceId, userId: created.userId });
      const foreign = yield* secretsManager.createUser({
        projectId,
        instanceId,
        description,
        write: false,
      });

      const { user: recreated } = yield* stack.deploy(program(undefined));
      expect(recreated.userId).not.toEqual(foreign.id);
      expect((yield* liveUsers(projectId, instanceId)).map((user) => user.id)).toContain(
        foreign.id,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
