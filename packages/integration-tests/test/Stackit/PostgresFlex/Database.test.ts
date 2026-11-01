import { withPgClient } from "@alchemy.run/sql/Migrations";
import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, instanceProps, observeDatabase, observeInstance, slow } from "./postgres.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("postgresflex", "database"),
  timeout: 2_700_000,
} as const;

/** An instance, two users to own a database, and the database when `database` is given. */
const app = (database?: { name?: string; owner: "first" | "second" }) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.PostgresFlex.Instance("DatabaseInstance", instanceProps());
    const first = yield* Stackit.PostgresFlex.User("FirstOwner", {
      instanceId: instance.instanceId,
    });
    const second = yield* Stackit.PostgresFlex.User("SecondOwner", {
      instanceId: instance.instanceId,
    });
    return {
      instance,
      first,
      second,
      database:
        database === undefined
          ? undefined
          : yield* Stackit.PostgresFlex.Database("DatabaseUnderTest", {
              instanceId: instance.instanceId,
              name: database.name,
              owner: database.owner === "first" ? first.userName : second.userName,
            }),
    };
  });

test.provider.skipIf(slow)(
  "create, update and delete a database",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({ owner: "first" }));
      const instanceId = created.instance.instanceId;
      const database = created.database!;

      expect(database.databaseId).toEqual(expect.any(Number));
      expect(database.instanceId).toEqual(instanceId);
      expect(database.name).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(database.owner).toEqual(created.first.userName);

      // Out of band: the database exists with the desired owner.
      const fetched = yield* postgres.getDatabase({
        projectId,
        region,
        instanceId,
        databaseId: database.databaseId,
      });
      expect(fetched.name).toEqual(database.name);
      expect(fetched.owner).toEqual(created.first.userName);

      // `list` enumerates it, and leaves system databases out.
      const provider = yield* Provider.findProvider(Stackit.PostgresFlex.Database);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.databaseId === database.databaseId)?.name).toEqual(
        database.name,
      );
      expect(listed.map((entry) => entry.name)).not.toContain("postgres");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ owner: "first" }));
      expect(plan.resources.DatabaseUnderTest).toMatchObject({ action: "noop" });

      // Rename and change the owner in place.
      const updated = yield* stack.deploy(
        app({ name: "alchemy_database_renamed", owner: "second" }),
      );
      expect(updated.database!.databaseId).toEqual(database.databaseId);
      expect(updated.database!.name).toEqual("alchemy_database_renamed");
      const refetched = yield* postgres.getDatabase({
        projectId,
        region,
        instanceId,
        databaseId: database.databaseId,
      });
      expect(refetched.name).toEqual("alchemy_database_renamed");
      expect(refetched.owner).toEqual(created.second.userName);

      // Removing it from the stack deletes the database and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeDatabase(projectId, region, instanceId, database.databaseId));
      const instance = yield* observeInstance(projectId, region, instanceId);
      expect(instance === "gone" ? "gone" : instance.state).toEqual("READY");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);

// A public instance reachable only from this machine's address: the direct `pg`
// connection is the only transport PostgreSQL Flex has.
test.provider.skipIf(slow)(
  "apply migrations over a direct connection, then only pending ones",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-postgres-flex-" });
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
        const instance = yield* Stackit.PostgresFlex.Instance(
          "MigrationsInstance",
          instanceProps(`${ip}/32`),
        );
        const user = yield* Stackit.PostgresFlex.User("MigrationsOwner", {
          instanceId: instance.instanceId,
        });
        const database = yield* Stackit.PostgresFlex.Database("MigrationsDatabase", {
          instanceId: instance.instanceId,
          owner: user.userName,
          migrations: dir,
          migrationsUser: user.userName,
          migrationsPassword: user.password,
        });
        return { instance, user, database };
      });

      /** Run SQL out of band, as the owner, over TLS. */
      const query = (
        deployed: {
          readonly instance: { readonly host: string; readonly port: number };
          readonly user: {
            readonly userName: string;
            readonly password: Redacted.Redacted<string> | undefined;
          };
          readonly database: { readonly name: string };
        },
        sql: string,
      ) =>
        withPgClient(
          {
            host: deployed.instance.host,
            port: deployed.instance.port,
            database: deployed.database.name,
            user: deployed.user.userName,
            password: Redacted.value(deployed.user.password!),
            ssl: { rejectUnauthorized: true },
          },
          (client) => Effect.tryPromise(() => client.query(sql)),
        ).pipe(Effect.map((result) => result.rows));

      yield* stack.destroy();

      const created = yield* stack.deploy(migrated);
      expect(created.database.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.database.migrationsHashes)).toEqual(["0001_users.sql"]);
      expect(yield* query(created, "SELECT name FROM __alchemy_migrations ORDER BY id")).toEqual([
        { name: "0001_users.sql" },
      ]);
      expect(yield* query(created, "SELECT id FROM users")).toEqual([{ id: 1 }]);

      // Nothing changed: the next deploy has nothing to apply.
      const unchanged = yield* stack.plan(migrated);
      expect(unchanged.resources.MigrationsDatabase).toMatchObject({ action: "noop" });

      // A new file updates in place, and only that file runs: the first one would
      // fail on its existing table.
      yield* add("0002_posts.sql", "CREATE TABLE posts (id INT PRIMARY KEY);");
      const pending = yield* stack.plan(migrated);
      expect(pending.resources.MigrationsDatabase).toMatchObject({ action: "update" });

      const updated = yield* stack.deploy(migrated);
      expect(updated.database.databaseId).toEqual(created.database.databaseId);
      expect(Object.keys(updated.database.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(yield* query(updated, "SELECT name FROM __alchemy_migrations ORDER BY id")).toEqual([
        { name: "0001_users.sql" },
        { name: "0002_posts.sql" },
      ]);
      expect(yield* query(updated, "SELECT id FROM users")).toEqual([{ id: 1 }]);

      const settled = yield* stack.plan(migrated);
      expect(settled.resources.MigrationsDatabase).toMatchObject({ action: "noop" });

      const instanceId = updated.instance.instanceId;
      const databaseId = updated.database.databaseId;
      yield* stack.destroy();

      yield* expectGone(observeDatabase(projectId, region, instanceId, databaseId));
      yield* expectGone(observeInstance(projectId, region, instanceId));
    }).pipe(logLevel),
  options,
);
