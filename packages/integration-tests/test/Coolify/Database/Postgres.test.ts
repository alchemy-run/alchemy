import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { databaseGone, hasServer, projectGone, testServer } from "../helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

test.provider.skipIf(!hasServer)(
  "create, update and delete a postgres database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const server = yield* testServer;

      const program = (description: string, memory: string) =>
        Effect.gen(function* () {
          const project = yield* Coolify.Project("PgProject", {});
          const db = yield* Coolify.Database.Postgres("Db", {
            project: project.projectUuid,
            environmentName: "production",
            server,
            database: "app",
            description,
            limits: { memory },
          });
          return { project, db };
        });

      const created = yield* stack.deploy(program("first", "512m"));
      expect(created.db.status).toMatch(/^running/);
      expect(created.db.database).toEqual("app");
      expect(created.db.user).toEqual("postgres");
      // The suite's token has read:sensitive.
      expect(created.db.password).toBeDefined();
      const internalUrl = Redacted.value(created.db.internalUrl!);
      expect(internalUrl).toContain(`@${created.db.databaseUuid}:5432/app`);

      const fetched = yield* CoolifyApi.getDatabase({ uuid: created.db.databaseUuid });
      expect(fetched.database_type).toEqual("standalone-postgresql");
      expect(fetched.limits_memory).toEqual("512m");

      const updated = yield* stack.deploy(program("second", "768m"));
      expect(updated.db.databaseUuid).toEqual(created.db.databaseUuid);
      const refetched = yield* CoolifyApi.getDatabase({ uuid: created.db.databaseUuid });
      expect(refetched.description).toEqual("second");
      expect(refetched.limits_memory).toEqual("768m");
      expect(refetched.status).toMatch(/^running/);

      yield* stack.destroy();
      expect(yield* databaseGone(created.db.databaseUuid)).toEqual("gone");
      expect(yield* projectGone(created.project.projectUuid)).toEqual("gone");
    }),
  {
    tags: ["provider:coolify", "provider:coolify:database", "live"],
    timeout: 600_000,
  },
);
