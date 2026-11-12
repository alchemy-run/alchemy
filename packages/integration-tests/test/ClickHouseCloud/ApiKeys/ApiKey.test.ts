import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/clickhouse-cloud/api_keys";
import * as userManagement from "@distilled.cloud/clickhouse-cloud/user_management";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getKey = (id: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* apiKeys.getApiKey({ organizationId, keyId: id }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

const expectGone = (id: string) =>
  getKey(id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (k) => k === undefined,
      times: 10,
    }),
    Effect.map((k) => expect(k).toBeUndefined()),
  );

/** One call authenticated with the new key, proving its secret works. */
const whoami = (keyId: string, keySecret: Redacted.Redacted<string>) =>
  userManagement
    .getWhoami({})
    .pipe(Effect.provide(ClickHouseCloud.fromApiKey({ keyId, keySecret })));

/** A role the key holds: keys can't be created without one on V2 organizations. */
const roleWith = (logicalId: string, permission: string, resource: "organization" | "instance") =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* ClickHouseCloud.RoleManagement.Role(logicalId, {
      policies: [
        {
          allowDeny: "ALLOW",
          permissions: [permission],
          resources: [
            resource === "organization" ? `organization/${organizationId}` : "instance/*",
          ],
        },
      ],
    });
  });

const keyStack = (props: {
  role: "Viewer" | "Other";
  name?: string;
  ipAccessList: ClickHouseCloud.ApiKeys.ApiKeyIpAccessEntry[];
  state?: "enabled" | "disabled";
}) =>
  Effect.gen(function* () {
    const viewer = yield* roleWith("Viewer", "control-plane:organization:view", "organization");
    const other = yield* roleWith("Other", "control-plane:service:view", "instance");
    const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Key", {
      ...(props.name !== undefined ? { name: props.name } : {}),
      assignedRoleIds: [props.role === "Viewer" ? viewer.roleId : other.roleId],
      ipAccessList: props.ipAccessList,
      ...(props.state !== undefined ? { state: props.state } : {}),
    });
    return { key, viewer, other };
  });

const roleIdsOf = (key: { assignedRoles?: { roleId?: string }[] } | undefined) =>
  (key?.assignedRoles ?? []).map((r) => r.roleId).sort();

test.provider(
  "create an API key with its role, update it and its roles in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const created = yield* stack.deploy(
        keyStack({
          role: "Viewer",
          ipAccessList: [{ source: "0.0.0.0/0", description: "anywhere" }],
        }),
      );
      expect(created.key.keyId).not.toEqual("");
      expect(Redacted.value(created.key.keySecret)).not.toEqual("");
      expect(created.key.state).toEqual("enabled");
      const observed = yield* getKey(created.key.id);
      expect(observed?.name).toEqual(created.key.name);
      expect(roleIdsOf(observed)).toEqual([created.viewer.roleId]);

      // The secret authenticates the API.
      const me = yield* whoami(created.key.keyId, created.key.keySecret);
      expect(me.result).toMatchObject({ name: created.key.name });

      // Name, access list, state and roles update the same key; the secret
      // is kept, and the dropped role is removed.
      const updated = yield* stack.deploy(
        keyStack({
          role: "Other",
          name: `${created.key.name}-renamed`,
          ipAccessList: [{ source: "198.51.100.0/24", description: "ci" }],
          state: "disabled",
        }),
      );
      expect(updated.key.id).toEqual(created.key.id);
      expect(Redacted.value(updated.key.keySecret)).toEqual(Redacted.value(created.key.keySecret));
      const afterUpdate = yield* getKey(created.key.id);
      expect(afterUpdate?.name).toEqual(`${created.key.name}-renamed`);
      expect(afterUpdate?.state).toEqual("disabled");
      expect(afterUpdate?.ipAccessList).toEqual([{ source: "198.51.100.0/24", description: "ci" }]);
      expect(roleIdsOf(afterUpdate)).toEqual([updated.other.roleId]);

      yield* stack.destroy();
      yield* expectGone(created.key.id);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider(
  "a key found by name has no secret: it is refused without adopt, re-minted with it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const name = `alchemy-adopt-${stack.stage.toLowerCase()}`.slice(0, 50);
      // A key with this name made outside the stack, as a create whose
      // result never reached state would leave it. Deleted when the test
      // ends, whatever happens.
      const outside = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const role = yield* ClickHouseCloud.RoleManagement.Role("Viewer", {
            policies: [
              {
                allowDeny: "ALLOW",
                permissions: ["control-plane:organization:view"],
                resources: [`organization/${organizationId}`],
              },
            ],
          }).pipe(stack.deploy);
          const { result } = yield* apiKeys.createApiKey({
            organizationId,
            name,
            assignedRoleIds: [role.roleId],
          });
          return { roleId: role.roleId, keyId: result!.key!.id! };
        }),
        ({ keyId }) =>
          apiKeys.deleteApiKey({ organizationId, keyId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.ignore,
          ),
      );
      const declare = Effect.gen(function* () {
        const role = yield* ClickHouseCloud.RoleManagement.Role("Viewer", {
          policies: [
            {
              allowDeny: "ALLOW",
              permissions: ["control-plane:organization:view"],
              resources: [`organization/${organizationId}`],
            },
          ],
        });
        return yield* ClickHouseCloud.ApiKeys.ApiKey("Key", {
          name,
          assignedRoleIds: [role.roleId],
        });
      });

      const refused = yield* stack.deploy(declare).pipe(Effect.flip);
      expect(refused._tag).toEqual("OwnedBySomeoneElse");
      expect((yield* getKey(outside.keyId))?.name).toEqual(name);

      const adopted = yield* stack.deploy(declare.pipe(adopt(true)));
      // The secret of the found key was never seen, so the key is replaced
      // by a new one whose secret is in state.
      expect(adopted.id).not.toEqual(outside.keyId);
      expect(adopted.name).toEqual(name);
      expect(Redacted.value(adopted.keySecret)).not.toEqual("");
      yield* expectGone(outside.keyId);
      const me = yield* whoami(adopted.keyId, adopted.keySecret);
      expect(me.result).toMatchObject({ name });

      yield* stack.destroy();
      yield* expectGone(adopted.id);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 180_000 },
);
