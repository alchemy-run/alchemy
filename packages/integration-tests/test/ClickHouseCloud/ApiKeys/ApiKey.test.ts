import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/clickhouse-cloud/api_keys";
import * as userManagement from "@distilled.cloud/clickhouse-cloud/user_management";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

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
      yield* stack.destroy();

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
    }),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
