import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("secretsmanager", "approle"), timeout: 300_000 } as const;

const Vault = Stackit.SecretsManager.Instance("AppRoleInstance", {});

const liveRoles = (projectId: string, instanceId: string) =>
  secretsManager
    .listApproles({ projectId, instanceId })
    .pipe(Effect.map(({ approles }) => approles));

test.provider(
  "create, update and delete an AppRole",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const program = (props: {
        description?: string;
        write?: boolean;
        secretIdTtl?: string;
        secretIdNumUses?: number;
      }) =>
        Effect.gen(function* () {
          const vault = yield* Vault;
          const role = yield* Stackit.SecretsManager.AppRole("BasicRole", {
            instanceId: vault.instanceId,
            ...props,
          });
          return { vault, role };
        });

      const { vault, role: created } = yield* stack.deploy(
        program({ secretIdTtl: "15m", secretIdNumUses: 3 }),
      );
      const instanceId = vault.instanceId;

      expect(created.roleId).toEqual(expect.any(String));
      expect(created.write).toEqual(false);
      expect(created.secretIdNumUses).toEqual(3);
      // A generated description holds the physical name.
      expect(created.description).toMatch(/^[a-z0-9-]+$/);

      const fetched = yield* secretsManager.getApprole({
        projectId,
        instanceId,
        roleId: created.roleId,
      });
      expect(fetched.secret_id_num_uses).toEqual(3);
      expect(fetched.write).toEqual(false);

      // STACKIT normalizes `15m` to `15m0s`. Reconciling again must not see a
      // difference: the role keeps its id and settings.
      const { role: again } = yield* stack.deploy(
        program({ secretIdTtl: "15m", secretIdNumUses: 3 }),
      );
      expect(again.roleId).toEqual(created.roleId);

      const { role: updated } = yield* stack.deploy(
        program({
          description: "updated role",
          write: true,
          secretIdTtl: "1h",
          secretIdNumUses: 1,
        }),
      );
      expect(updated.roleId).toEqual(created.roleId);
      expect(updated.description).toEqual("updated role");

      const refetched = yield* secretsManager.getApprole({
        projectId,
        instanceId,
        roleId: created.roleId,
      });
      expect(refetched.description).toEqual("updated role");
      expect(refetched.write).toEqual(true);
      expect(refetched.secret_id_num_uses).toEqual(1);
      expect(refetched.secret_id_ttl).toMatch(/^1h/);

      // Removing the resource deletes the AppRole, and the instance stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          const live = yield* Vault;
          return { live };
        }),
      );
      expect((yield* liveRoles(projectId, instanceId)).map((role) => role.role_id)).not.toContain(
        created.roleId,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
