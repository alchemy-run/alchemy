import { withMssqlExecutor } from "@alchemy.run/sql/Migrations";
import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  gated,
  instanceProps,
  observeDatabase,
  observeInstance,
  ROLES,
} from "./sqlserver.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("sqlserverflex", "database"),
  timeout: 2_700_000,
} as const;

// One test on purpose: every instance costs at least an hour's licence, so the
// lifecycle and the migrations share it. The instance is reachable only from this
// machine's address: the direct TDS connection is the only transport SQL Server Flex
// has.
test.provider.skipIf(gated)(
  "create, migrate, replace and delete a database",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-sqlserver-flex-" });
      const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
      yield* add(
        "0001_users.sql",
        [
          "CREATE TABLE users (id INT PRIMARY KEY);",
          "GO",
          "CREATE PROCEDURE add_user @id INT AS INSERT INTO users (id) VALUES (@id);",
          "GO",
          "EXEC add_user 1;",
        ].join("\n"),
      );
      const ip = yield* HttpClient.get("https://checkip.amazonaws.com").pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((text) => text.trim()),
      );

      const app = (
        database?: { name?: string; owner: "first" | "second"; replaceOnOwnerChange?: boolean },
        namedOwnerRoles: string[] = ROLES,
      ) =>
        Effect.gen(function* () {
          const instance = yield* Stackit.SQLServerFlex.Instance(
            "DatabaseInstance",
            instanceProps(`${ip}/32`),
          );
          const first = yield* Stackit.SQLServerFlex.User("FirstOwner", {
            instanceId: instance.instanceId,
            roles: ROLES,
          });
          const second = yield* Stackit.SQLServerFlex.User("SecondOwner", {
            instanceId: instance.instanceId,
            roles: ROLES,
          });
          const owner = database?.owner === "first" ? first : second;
          const namedOwner = yield* Stackit.SQLServerFlex.User("NamedOwner", {
            instanceId: instance.instanceId,
            userName: "alchemy_named_owner",
            roles: namedOwnerRoles,
          });
          return {
            instance,
            first,
            second,
            owner,
            namedOwner,
            kept: yield* Stackit.SQLServerFlex.Database("KeptDatabase", {
              instanceId: instance.instanceId,
              owner: namedOwner.userName,
            }),
            database:
              database === undefined
                ? undefined
                : yield* Stackit.SQLServerFlex.Database("DatabaseUnderTest", {
                    instanceId: instance.instanceId,
                    name: database.name,
                    owner: owner.userName,
                    replaceOnOwnerChange: database.replaceOnOwnerChange,
                    migrations: dir,
                    migrationsUser: owner.userName,
                    migrationsPassword: owner.password,
                  }),
          };
        });

      /** Run SQL out of band, as the owner, over TLS. */
      const query = (
        deployed: {
          readonly owner: {
            readonly host: string;
            readonly port: number;
            readonly userName: string;
            readonly password: Redacted.Redacted<string> | undefined;
          };
          readonly database?: { readonly name: string } | undefined;
        },
        sql: string,
      ) =>
        withMssqlExecutor(
          {
            server: deployed.owner.host,
            port: deployed.owner.port,
            database: deployed.database!.name,
            user: deployed.owner.userName,
            password: Redacted.value(deployed.owner.password!),
            options: { encrypt: true, trustServerCertificate: false },
          },
          (executor) => executor.query(sql),
        );

      yield* stack.destroy();

      const created = yield* stack.deploy(app({ owner: "first" }));
      const instanceId = created.instance.instanceId;
      const database = created.database!;

      expect(database.databaseId).toEqual(expect.any(Number));
      expect(database.instanceId).toEqual(instanceId);
      expect(database.name).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(database.owner).toEqual(created.first.userName);
      expect(database.collationName.length).toBeGreaterThan(0);
      expect(database.compatibilityLevel).toBeGreaterThan(0);

      // Out of band: the database exists with the desired owner.
      const fetched = yield* sqlserver.getDatabase({
        projectId,
        region,
        instanceId,
        databaseName: database.name,
      });
      expect(fetched.id).toEqual(database.databaseId);
      expect(fetched.owner).toEqual(created.first.userName);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.SQLServerFlex.Database);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.name === database.name)?.databaseId).toEqual(
        database.databaseId,
      );

      // The migration and its `GO` batches ran, and are on record.
      expect(database.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(database.migrationsHashes)).toEqual(["0001_users.sql"]);
      expect(yield* query(created, "SELECT name FROM __alchemy_migrations ORDER BY id;")).toEqual([
        { name: "0001_users.sql" },
      ]);
      expect(yield* query(created, "SELECT id FROM users;")).toEqual([{ id: 1 }]);

      // Nothing changed: the next deploy has nothing to do, and doesn't replace.
      const unchanged = yield* stack.plan(app({ owner: "first" }));
      expect(unchanged.resources.DatabaseUnderTest).toMatchObject({ action: "noop" });

      // A new file updates in place, and only that file runs: the first one would
      // fail on its existing table.
      yield* add("0002_posts.sql", "CREATE TABLE posts (id INT PRIMARY KEY);");
      const pending = yield* stack.plan(app({ owner: "first" }));
      expect(pending.resources.DatabaseUnderTest).toMatchObject({ action: "update" });

      const updated = yield* stack.deploy(app({ owner: "first" }));
      expect(updated.database!.databaseId).toEqual(database.databaseId);
      expect(Object.keys(updated.database!.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(yield* query(updated, "SELECT name FROM __alchemy_migrations ORDER BY id;")).toEqual([
        { name: "0001_users.sql" },
        { name: "0002_posts.sql" },
      ]);
      expect(yield* query(updated, "SELECT id FROM users;")).toEqual([{ id: 1 }]);

      const settled = yield* stack.plan(app({ owner: "first" }));
      expect(settled.resources.DatabaseUnderTest).toMatchObject({ action: "noop" });

      // A role edit replaces a user that owns a database. Under an explicit name the
      // owner's name stays, so the database stays with its id.
      const roleEdit = [...ROLES, "##STACKIT_ProcessManager##"];
      const rolePlan = yield* stack.plan(app({ owner: "first" }, roleEdit));
      expect(rolePlan.resources.NamedOwner).toMatchObject({ action: "replace" });
      expect(rolePlan.resources.KeptDatabase).not.toMatchObject({ action: "replace" });
      const edited = yield* stack.deploy(app({ owner: "first" }, roleEdit));
      expect(edited.kept.databaseId).toEqual(created.kept.databaseId);
      expect(edited.kept.owner).toEqual("alchemy_named_owner");

      // The API can't move ownership, so a new owner fails the deploy, and the database
      // keeps its data.
      const refused = yield* stack.deploy(app({ owner: "second" }, roleEdit)).pipe(Effect.flip);
      expect(refused._tag).toEqual("Stackit.SQLServerFlex.DatabaseOwnerChanged");
      const refusedLive = yield* sqlserver.getDatabase({
        projectId,
        region,
        instanceId,
        databaseName: database.name,
      });
      expect(refusedLive.id).toEqual(database.databaseId);
      expect(refusedLive.owner).toEqual(created.first.userName);

      // On request it replaces the database. Under a generated name the new one comes up
      // first, under its own name.
      const secondOwner = { owner: "second", replaceOnOwnerChange: true } as const;
      const replacePlan = yield* stack.plan(app(secondOwner, roleEdit));
      expect(replacePlan.resources.DatabaseUnderTest).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(app(secondOwner, roleEdit));
      expect(replaced.database!.name).not.toEqual(database.name);
      expect(replaced.database!.owner).toEqual(created.second.userName);
      yield* expectGone(observeDatabase(projectId, region, instanceId, database.name));
      expect(yield* query(replaced, "SELECT id FROM users;")).toEqual([{ id: 1 }]);

      // Under an explicit name, the old database has to go first.
      const named = yield* stack.deploy(
        app({ name: "alchemy_orders", owner: "second", replaceOnOwnerChange: true }, roleEdit),
      );
      expect(named.database!.name).toEqual("alchemy_orders");
      yield* expectGone(observeDatabase(projectId, region, instanceId, replaced.database!.name));
      const renewed = yield* stack.deploy(
        app({ name: "alchemy_orders", owner: "first", replaceOnOwnerChange: true }, roleEdit),
      );
      expect(renewed.database!.name).toEqual("alchemy_orders");
      expect(renewed.database!.owner).toEqual(created.first.userName);
      const renewedLive = yield* sqlserver.getDatabase({
        projectId,
        region,
        instanceId,
        databaseName: "alchemy_orders",
      });
      expect(renewedLive.owner).toEqual(created.first.userName);

      // Removing it from the stack deletes the database and leaves the instance.
      yield* stack.deploy(app(undefined, roleEdit));
      yield* expectGone(observeDatabase(projectId, region, instanceId, "alchemy_orders"));
      const instance = yield* observeInstance(projectId, region, instanceId);
      expect(instance === "gone" ? "gone" : instance.state).toEqual("READY");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);
