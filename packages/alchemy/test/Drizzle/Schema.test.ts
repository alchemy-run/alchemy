import * as Drizzle from "@/Drizzle";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import {
  inMemoryState,
  InMemoryService,
  State,
  type ResourceState,
} from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const TEST_STACK = "test";
const TEST_STAGE = "test";

const freshState = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);

const { test } = Test.make({
  providers: Drizzle.providers(),
  state: freshState,
});

const seed = (resources: Record<string, ResourceState>) =>
  Effect.gen(function* () {
    const state = yield* State;
    for (const [fqn, value] of Object.entries(resources)) {
      yield* state.set({
        stack: TEST_STACK,
        stage: TEST_STAGE,
        fqn,
        value,
      });
    }
  });

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  // @ts-expect-error - Stack.make's typing erases R unsoundly here
  Effect.gen(function* () {
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make({
        name: TEST_STACK,
        providers: Layer.empty,
        state: inMemoryState(),
      }),
      Effect.provideService(Stage, TEST_STAGE),
      Effect.flatMap((stackSpec: any) => Plan.make(stackSpec)),
      Effect.provide(Drizzle.providers()),
    );
  });

// Minimal drizzle-orm schema source. We only need something
// `generateDrizzleJson` can introspect — a couple of pgTable definitions
// are enough.
const SCHEMA_SOURCE = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
`;

/**
 * Stage a temp directory with a real \`schema.ts\` and a freshly generated
 * migration snapshot (mirroring the on-disk layout of a project that has
 * already deployed the schema once).
 */
const stageSchemaWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({
    prefix: "alchemy-drizzle-schema-test-",
  });
  const schemaPath = path.join(root, "schema.ts");
  yield* fs.writeFileString(schemaPath, SCHEMA_SOURCE);

  const out = path.join(root, "migrations");
  yield* fs.makeDirectory(out, { recursive: true });

  // Generate the initial snapshot via drizzle-kit so it matches what a
  // first-time `regenerate` would have produced.
  const kit = (yield* Effect.tryPromise(
    () =>
      import(
        /* @vite-ignore */ "drizzle-kit/api-postgres"
      ) as Promise<any>,
  )) as any;
  const schemaModule = (yield* Effect.tryPromise(
    () => import(/* @vite-ignore */ schemaPath) as Promise<any>,
  )) as any;
  const cur = (yield* Effect.tryPromise(() =>
    kit.generateDrizzleJson(schemaModule),
  )) as any;
  const empty = (yield* Effect.tryPromise(() =>
    kit.generateDrizzleJson({}),
  )) as any;
  const sql = (yield* Effect.tryPromise(() =>
    kit.generateMigration(empty, cur),
  )) as string[];

  const dirName = "20000101000000_migration";
  const dirPath = path.join(out, dirName);
  yield* fs.makeDirectory(dirPath, { recursive: true });
  yield* fs.writeFileString(
    path.join(dirPath, "migration.sql"),
    sql.join("\n--> statement-breakpoint\n") + "\n",
  );
  const snapshotText = JSON.stringify(cur, null, 2);
  yield* fs.writeFileString(path.join(dirPath, "snapshot.json"), snapshotText);

  // Mimic what `regenerate` returns so we can seed the resource state.
  const crypto = yield* Effect.tryPromise(() => import("node:crypto"));
  const snapshotHash = crypto
    .createHash("sha256")
    .update(snapshotText)
    .digest("hex");

  return { root, out, schemaPath, snapshotHash, dirName };
});

test(
  "Drizzle.Schema noops when nothing has drifted (regression: forced update cascaded into Neon.Branch)",
  Effect.gen(function* () {
    const ws = yield* stageSchemaWorkspace;

    yield* seed({
      "app-schema": {
        instanceId: "app-schema-instance",
        providerVersion: 0,
        logicalId: "app-schema",
        fqn: "app-schema",
        namespace: undefined,
        resourceType: "Drizzle.Schema",
        status: "created",
        props: {
          schema: ws.schemaPath,
          out: ws.out,
        },
        attr: {
          out: ws.out,
          snapshotHash: ws.snapshotHash,
          migrations: [ws.dirName],
        },
        bindings: [],
        downstream: [],
      },
    });

    const plan = yield* makePlan(
      Effect.gen(function* () {
        return yield* Drizzle.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        });
      }),
    );

    expect(plan.resources["app-schema"]?.action).toEqual("noop");

    // And no spurious second migration directory was written.
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(ws.out);
    expect(entries.filter((n) => /^\d+_/.test(n))).toEqual([ws.dirName]);
  }),
  60_000,
);

test(
  "Drizzle.Schema reports update when the schema has actually drifted",
  Effect.gen(function* () {
    const ws = yield* stageSchemaWorkspace;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Write the drifted schema as a *new* file so the dynamic import
    // cache doesn't hand us the original module.
    const driftedSchemaPath = path.join(ws.root, "schema-drifted.ts");
    yield* fs.writeFileString(
      driftedSchemaPath,
      SCHEMA_SOURCE +
        `\nexport const posts = pgTable("posts", {\n  id: serial("id").primaryKey(),\n  title: text("title").notNull(),\n});\n`,
    );

    yield* seed({
      "app-schema": {
        instanceId: "app-schema-instance",
        providerVersion: 0,
        logicalId: "app-schema",
        fqn: "app-schema",
        namespace: undefined,
        resourceType: "Drizzle.Schema",
        status: "created",
        props: {
          schema: driftedSchemaPath,
          out: ws.out,
        },
        attr: {
          out: ws.out,
          snapshotHash: ws.snapshotHash,
          migrations: [ws.dirName],
        },
        bindings: [],
        downstream: [],
      },
    });

    const plan = yield* makePlan(
      Effect.gen(function* () {
        return yield* Drizzle.Schema("app-schema", {
          schema: driftedSchemaPath,
          out: ws.out,
        });
      }),
    );

    expect(plan.resources["app-schema"]?.action).toEqual("update");
  }),
  60_000,
);
