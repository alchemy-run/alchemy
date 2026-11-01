import { withMySqlConnection } from "@alchemy.run/sql/Migrations";
import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  instanceProps,
  observeInstance,
  PLAN,
  slow,
  VERSION,
} from "./mariadb.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("mariadb", "instance"),
  timeout: 2_700_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

/** The parameters the API reports, under either spelling of a key. */
const parameter = (instance: { readonly parameters: unknown }, key: string): unknown => {
  const parameters = instance.parameters as Record<string, unknown>;
  return parameters[key] ?? parameters[key.replaceAll("_", "-")];
};

test.provider.skipIf(slow)(
  "create, update, list and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { ...instanceProps(), enableMonitoring: false };
      const created = yield* stack.deploy(Stackit.MariaDB.Instance("BasicInstance", props));

      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(regionId);
      expect(created.status).toEqual("active");
      expect(created.planName.toLowerCase()).toEqual(PLAN.toLowerCase());
      expect(created.acl).toEqual([CLOSED_ACL]);

      // Out of band: the plan and parameters landed.
      const fetched = yield* mariadb.getInstance({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(parameter(fetched, "sgw_acl")).toEqual(CLOSED_ACL);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.MariaDB.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.MariaDB.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update in place. Leaving `automaticUpdates` set proves the sync against the
      // observed setting. Version and plan stay: a run has no higher plan to move to.
      const updated = yield* stack.deploy(
        Stackit.MariaDB.Instance("BasicInstance", {
          ...instanceProps(UPDATED_ACL),
          enableMonitoring: false,
          automaticUpdates: true,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.acl).toEqual([UPDATED_ACL]);
      expect(updated.automaticUpdates).toEqual(true);

      const refetched = yield* mariadb.getInstance({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(parameter(refetched, "sgw_acl")).toEqual(UPDATED_ACL);
      const updates = yield* mariadb.getUpdates({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(updates.automaticUpdatesEnabled).toEqual(true);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, regionId, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a new name replaces the instance and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.MariaDB.Instance("RenamedInstance", {
          ...instanceProps(),
          name: "alchemy-test-mariadb-first",
        }),
      );
      expect(first.name).toEqual("alchemy-test-mariadb-first");

      const second = yield* stack.deploy(
        Stackit.MariaDB.Instance("RenamedInstance", {
          ...instanceProps(),
          name: "alchemy-test-mariadb-second",
        }),
      );
      expect(second.instanceId).not.toEqual(first.instanceId);
      expect(second.name).toEqual("alchemy-test-mariadb-second");
      yield* expectGone(observeInstance(projectId, regionId, first.instanceId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, regionId, second.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an explicit name with no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-mariadb-foreign";
      const { offerings } = yield* mariadb.listOfferings({ projectId, regionId });
      const plans = offerings.flatMap((offering) =>
        offering.version === VERSION ? offering.plans : [],
      );
      const planId = plans.find((plan) => plan.name === PLAN)?.id;
      expect(planId).toEqual(expect.any(String));
      const foreign = yield* mariadb.createInstance({
        projectId,
        regionId,
        instanceName: name,
        planId: planId!,
      });

      const error = yield* stack
        .deploy(Stackit.MariaDB.Instance("ForeignInstance", { ...instanceProps(), name }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The foreign instance was neither taken over nor removed.
      const active = yield* mariadb
        .getInstance({ projectId, regionId, instanceId: foreign.instanceId })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (instance) => instance.status !== "creating",
            times: 120,
          }),
        );
      expect(active.name).toEqual(name);

      yield* mariadb.deleteInstance({ projectId, regionId, instanceId: foreign.instanceId });
      yield* expectGone(observeInstance(projectId, regionId, foreign.instanceId));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "apply migrations over a direct connection, then only pending ones",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-mariadb-" });
      const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
      yield* add(
        "0001_users.sql",
        "CREATE TABLE users (id INT PRIMARY KEY); INSERT INTO users (id) VALUES (1);",
      );
      const ip = yield* HttpClient.get("https://checkip.amazonaws.com").pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((text) => text.trim()),
      );

      const migrated = Effect.gen(function* () {
        const instance = yield* Stackit.MariaDB.Instance("MigrationsInstance", {
          ...instanceProps(`${ip}/32`),
          migrations: dir,
        });
        const credential = yield* Stackit.MariaDB.Credential("MigrationsCredential", {
          instanceId: instance.instanceId,
        });
        return { instance, credential };
      });

      /** Run SQL out of band, with the stack's own credential. */
      const query = (uri: Redacted.Redacted<string>, sql: string) =>
        withMySqlConnection({ uri: Redacted.value(uri) }, (connection) =>
          Effect.tryPromise(() => connection.query(sql).then(([rows]) => rows as unknown[])),
        );

      yield* stack.destroy();
      const created = yield* stack.deploy(migrated);
      expect(created.instance.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.instance.migrationsHashes)).toEqual(["0001_users.sql"]);
      expect(yield* query(created.credential.uri, "SELECT id FROM users")).toEqual([{ id: 1 }]);

      // The credential the run created is gone: only the stack's own is left.
      const credentials = yield* mariadb.listCredentials({
        projectId,
        regionId,
        instanceId: created.instance.instanceId,
      });
      expect(credentials.credentialsList.map((item) => item.id)).toEqual([
        created.credential.credentialId,
      ]);

      // Unchanged: no update planned.
      const plan = yield* stack.plan(migrated);
      expect(plan.resources.MigrationsInstance).toMatchObject({ action: "noop" });

      // A new file: only it runs. A rerun of the first would fail on its duplicate row.
      yield* add("0002_more.sql", "INSERT INTO users (id) VALUES (2);");
      const updated = yield* stack.deploy(migrated);
      expect(updated.instance.instanceId).toEqual(created.instance.instanceId);
      expect(Object.keys(updated.instance.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_more.sql",
      ]);
      expect(yield* query(updated.credential.uri, "SELECT id FROM users ORDER BY id")).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(
        yield* query(updated.credential.uri, "SELECT name FROM __alchemy_migrations ORDER BY name"),
      ).toEqual([{ name: "0001_users.sql" }, { name: "0002_more.sql" }]);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, regionId, created.instance.instanceId));
    }).pipe(logLevel),
  options,
);
