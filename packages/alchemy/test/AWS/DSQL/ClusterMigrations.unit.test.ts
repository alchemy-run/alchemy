import { Cluster, ClusterProvider } from "@/AWS/DSQL/Cluster.ts";
import * as Provider from "@/Provider.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { readFlatRecords } from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const describe = layer(NodeServices.layer);
const getProvider = Provider.Provider<Cluster>(Cluster.Type).pipe(
  Effect.provide(ClusterProvider()),
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(
        AWSEnvironment,
        Effect.die("Unexpected AWS environment access"),
      ),
      Layer.succeed(
        Credentials,
        Effect.die("Unexpected AWS credential access"),
      ),
      Layer.succeed(Region, Effect.die("Unexpected AWS region access")),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
      Layer.succeed(Stack, {
        name: "test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Layer.succeed(Stage, "test"),
    ),
  ),
);
const diffInput = {
  id: "Database",
  fqn: "Database",
  instanceId: "instance",
  olds: {},
  oldBindings: [],
  newBindings: [],
};

describe("DSQL migration lifecycle", (it) => {
  it.effect(
    "diff detects changed migration content at an unchanged directory path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "0001_users.sql");
        yield* fs.writeFileString(
          file,
          "CREATE TABLE users(id uuid PRIMARY KEY);",
        );
        const [record] = yield* readFlatRecords(dir);
        const provider = yield* getProvider;
        const output: Cluster["Attributes"] = {
          clusterId: "cluster",
          clusterArn: "arn",
          status: "ACTIVE",
          endpoint: "endpoint",
          deletionProtectionEnabled: false,
          migrationsDir: dir,
          migrationsTable: "__alchemy_migrations",
          migrationsHashes: { [record.name]: record.hash },
        };
        expect(
          yield* provider.diff!({
            ...diffInput,
            news: { migrations: dir },
            output,
          }),
        ).toBeUndefined();
        yield* fs.writeFileString(
          path.join(dir, "0002_email.sql"),
          "ALTER TABLE users ADD COLUMN email text;",
        );
        expect(
          yield* provider.diff!({
            ...diffInput,
            news: { migrations: dir },
            output,
          }),
        ).toEqual({ action: "update" });
        yield* fs.writeFileString(
          file,
          "CREATE TABLE users(id text PRIMARY KEY);",
        );
        const edited = yield* Effect.result(
          provider.diff!({ ...diffInput, news: { migrations: dir }, output }),
        );
        expect(Result.isFailure(edited)).toBe(true);
        if (Result.isFailure(edited))
          expect(String(edited.failure)).toContain("Expected SHA256");
      }),
  );

  it.effect(
    "preflight rejects an invalid later migration before accessing AWS",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          path.join(dir, "0001_users.sql"),
          "CREATE TABLE users(id uuid PRIMARY KEY);",
        );
        yield* fs.writeFileString(
          path.join(dir, "0002_bad.sql"),
          "BEGIN; CREATE TABLE bad(id uuid); COMMIT;",
        );
        const provider = yield* getProvider;
        const planned = yield* Effect.result(
          provider.diff!({
            ...diffInput,
            news: { migrations: dir },
            output: undefined,
          }),
        );
        expect(Result.isFailure(planned)).toBe(true);
        if (Result.isFailure(planned))
          expect(String(planned.failure)).toContain("0002_bad.sql");
        // Deliberately provide no AWS environment or credentials. Preflight must
        // fail before provisioning/tagging or opening any database connection.
        const deployed = yield* Effect.result(
          provider.reconcile({
            id: "Database",
            fqn: "Database",
            instanceId: "instance",
            news: { migrations: dir },
            olds: undefined,
            output: undefined,
            bindings: [],
            session: { note: () => Effect.void } as never,
          }),
        );
        expect(Result.isFailure(deployed)).toBe(true);
        if (Result.isFailure(deployed))
          expect(String(deployed.failure)).toContain("0002_bad.sql");
      }),
  );
});
