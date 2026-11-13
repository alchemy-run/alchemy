import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/clickhouse-cloud/api_keys";
import * as roles from "@distilled.cloud/clickhouse-cloud/role_management";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getRole = (roleId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* roles
      .getOrganizationRole({ organizationId, roleId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

const keyRoleIds = (keyId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    const result = yield* apiKeys.getApiKey({ organizationId, keyId });
    return (result?.assignedRoles ?? []).map((r) => r.roleId);
  });

const orgView = (organizationId: string) => ({
  allowDeny: "ALLOW" as const,
  permissions: ["control-plane:organization:view"],
  resources: [`organization/${organizationId}`],
});

test.provider(
  "create a role that adds a key through actors, update policies in place, leave actors alone, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;

      const firstStack = Effect.gen(function* () {
        // A key is created with its first role; the role under test adds
        // itself through `actors`.
        const base = yield* ClickHouseCloud.RoleManagement.Role("Base", {
          policies: [orgView(organizationId)],
        });
        const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Key", {
          assignedRoleIds: [base.roleId],
        });
        const role = yield* ClickHouseCloud.RoleManagement.Role("Role", {
          policies: [orgView(organizationId)],
          actors: [Output.interpolate`apiKey/${key.id}`],
        });
        return { key, role };
      });
      const first = yield* stack.deploy(firstStack);
      expect(first.role.type).toEqual("custom");
      expect(first.role.actors).toEqual([`apiKey/${first.key.id}`]);
      const observed = yield* getRole(first.role.roleId);
      // ClickHouse adds implied permissions (`view-udfs`) to the declared one.
      expect(observed?.policies?.[0]?.permissions).toContain("control-plane:organization:view");
      // Redeploying unchanged props leaves the role as it is.
      const unchanged = yield* stack.deploy(firstStack);
      expect(unchanged.role.updatedAt).toEqual(first.role.updatedAt);
      // The key holds both roles: its own and the one that named it.
      expect(yield* keyRoleIds(first.key.id)).toContain(first.role.roleId);

      // New policies update the same role; omitting `actors` keeps them.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const base = yield* ClickHouseCloud.RoleManagement.Role("Base", {
            policies: [orgView(organizationId)],
          });
          const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Key", {
            assignedRoleIds: [base.roleId],
          });
          const role = yield* ClickHouseCloud.RoleManagement.Role("Role", {
            policies: [
              orgView(organizationId),
              {
                allowDeny: "ALLOW",
                permissions: ["control-plane:service:view"],
                resources: ["instance/*"],
              },
            ],
          });
          return { key, role };
        }),
      );
      expect(second.role.roleId).toEqual(first.role.roleId);
      const afterUpdate = yield* getRole(first.role.roleId);
      expect(afterUpdate?.policies?.length).toEqual(2);
      expect(afterUpdate?.actors).toEqual([`apiKey/${first.key.id}`]);
      // Redeploying the key keeps the role it didn't assign.
      expect(yield* keyRoleIds(first.key.id)).toContain(first.role.roleId);

      yield* stack.destroy();
      const gone = yield* getRole(first.role.roleId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => r === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
