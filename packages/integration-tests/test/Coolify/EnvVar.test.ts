import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { hasServer, projectGone, testServer } from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

const valueOf = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

test.provider.skipIf(!hasServer)(
  "manage variables on an application and a database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const server = yield* testServer;

      const program = (apiKey: string) =>
        Effect.gen(function* () {
          const project = yield* Coolify.Project("EnvVarProject", {});
          const app = yield* Coolify.Application("Web", {
            project: project.projectUuid,
            environmentName: "production",
            server,
            image: "nginx:1.27-alpine",
            ports: [80],
          });
          const db = yield* Coolify.Database.Postgres("Db", {
            project: project.projectUuid,
            environmentName: "production",
            server,
          });
          const appVar = yield* Coolify.EnvVar("ApiKey", {
            application: app.applicationUuid,
            key: "API_KEY",
            value: Redacted.make(apiKey),
          });
          const dbVar = yield* Coolify.EnvVar("Tz", {
            database: db.databaseUuid,
            key: "TZ",
            value: "Europe/Brussels",
          });
          return { project, app, db, appVar, dbVar };
        });

      const created = yield* stack.deploy(program("one"));
      expect(created.appVar.targetKind).toEqual("application");
      expect(created.dbVar.targetKind).toEqual("database");

      const appEnvs = yield* CoolifyApi.listEnvsByApplicationUuid({
        uuid: created.app.applicationUuid,
      });
      const apiKey = appEnvs.find((e) => e.key === "API_KEY" && !e.is_preview);
      expect(apiKey?.uuid).toEqual(created.appVar.envVarUuid);
      expect(valueOf(apiKey?.value)).toEqual("one");

      const dbEnvs = yield* CoolifyApi.listEnvsByDatabaseUuid({ uuid: created.db.databaseUuid });
      expect(valueOf(dbEnvs.find((e) => e.key === "TZ")?.value)).toEqual("Europe/Brussels");

      const updated = yield* stack.deploy(program("two"));
      expect(updated.appVar.envVarUuid).toEqual(created.appVar.envVarUuid);
      expect(updated.appVar.digest).not.toEqual(created.appVar.digest);
      const appEnvsAfter = yield* CoolifyApi.listEnvsByApplicationUuid({
        uuid: created.app.applicationUuid,
      });
      expect(valueOf(appEnvsAfter.find((e) => e.key === "API_KEY")?.value)).toEqual("two");

      yield* stack.destroy();
      expect(yield* projectGone(created.project.projectUuid)).toEqual("gone");
    }),
  { tags: ["provider:coolify", "provider:coolify:envvar", "live"], timeout: 600_000 },
);
