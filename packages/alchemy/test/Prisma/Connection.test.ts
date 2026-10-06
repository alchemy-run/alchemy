import {
  createConnection,
  deleteConnection,
  getConnection,
  getDatabaseConnections,
} from "@distilled.cloud/prisma/management";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Drift from "@/Drift.ts";
import * as Prisma from "@/Prisma";
import { connectEnvKeys } from "@/Prisma/Connect";
import * as Test from "@/Test/Alchemy";
import { restoreRowAttr } from "./fixtures/ConnectionLive.ts";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:connection",
  "provider:prisma:database",
  "provider:prisma:project",
  "live",
];

const databaseStack = Effect.gen(function* () {
  const project = yield* Prisma.Project("Project", { createDatabase: false });
  const database = yield* Prisma.Database("Main", { project });
  return { project, database };
});

const connectionStack = (
  props: { name?: string; rotate?: boolean } = {},
  options: { adopt?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { project, database } = yield* databaseStack;
    const declared = Prisma.Connection("Api", { database, ...props });
    const connection = yield* options.adopt ? declared.pipe(adopt(true)) : declared;
    return { project, database, connection };
  });

const listConnections = (databaseId: string) =>
  getDatabaseConnections({ databaseId, limit: 100 }).pipe(Effect.map((page) => page.data));

const observeConnection = (id: string) =>
  getConnection({ id }).pipe(Effect.map((response) => response.data));

const expectConnectionGone = (id: string) =>
  expectGone(
    getConnection({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const secret = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

live.test.provider(
  "names a connection after its logical ID, materializes URLs and origins, and replaces it on rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(connectionStack());
    const connection = initial.connection;
    // name omitted -> logical ID prefix + instance identity suffix
    expect(connection.connectionName).toMatch(/^Api-[0-9a-zA-Z]{12}$/);
    expect(connection.databaseId).toBe(initial.database.databaseId);
    const observed = yield* observeConnection(connection.connectionId);
    expect(observed.name).toBe(connection.connectionName);
    expect(observed.database.id).toBe(initial.database.databaseId);

    const direct = secret(connection.directConnectionString);
    const pooled = secret(connection.pooledConnectionString);
    expect(direct).toBeDefined();
    // databaseUrl prefers the pooled endpoint for application traffic.
    expect(secret(connection.databaseUrl)).toBe(pooled ?? direct);
    // origin parses the direct connection string into Hyperdrive's shape.
    const directUrl = new URL(direct!);
    expect(connection.origin?.host).toBe(directUrl.hostname);
    expect(connection.origin?.scheme).toBe(directUrl.protocol.replace(/:$/, ""));
    expect(connection.host).toBe(directUrl.hostname);
    if (pooled !== undefined) {
      expect(connection.pooledOrigin?.host).toBe(new URL(pooled).hostname);
    }

    const repeated = yield* stack.deploy(connectionStack());
    expect(repeated.connection.connectionId).toBe(connection.connectionId);

    const planned = yield* stack.plan(connectionStack({ name: "api" }));
    expect(planned.resources.Api?.action).toBe("replace");
    const renamed = yield* stack.deploy(connectionStack({ name: "api" }));
    expect(renamed.connection.connectionId).not.toBe(connection.connectionId);
    expect(renamed.connection.connectionName).toMatch(/^api-[0-9a-zA-Z]{12}$/);
    expect((yield* observeConnection(renamed.connection.connectionId)).name).toBe(
      renamed.connection.connectionName,
    );
    yield* expectConnectionGone(connection.connectionId);

    yield* stack.destroy();
    yield* expectConnectionGone(renamed.connection.connectionId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "rotates credentials in place when rotate turns on and not again when it resets",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(connectionStack({ name: "api" }));
    const id = initial.connection.connectionId;
    const original = secret(initial.connection.directConnectionString);
    expect(original).toBeDefined();

    const stable = yield* stack.deploy(connectionStack({ name: "api" }));
    expect(stable.connection.connectionId).toBe(id);
    expect(secret(stable.connection.directConnectionString)).toBe(original);

    const planned = yield* stack.plan(connectionStack({ name: "api", rotate: true }));
    expect(planned.resources.Api?.action).toBe("update");
    const rotated = yield* stack.deploy(connectionStack({ name: "api", rotate: true }));
    expect(rotated.connection.connectionId).toBe(id);
    expect(rotated.connection.connectionName).toBe(initial.connection.connectionName);
    const first = secret(rotated.connection.directConnectionString);
    expect(first).toBeDefined();
    expect(first).not.toBe(original);

    const kept = yield* stack.deploy(connectionStack({ name: "api", rotate: true }));
    expect(secret(kept.connection.directConnectionString)).toBe(first);

    const reset = yield* stack.deploy(connectionStack({ name: "api", rotate: false }));
    expect(reset.connection.connectionId).toBe(id);
    expect(secret(reset.connection.directConnectionString)).toBe(first);

    const again = yield* stack.deploy(connectionStack({ name: "api", rotate: true }));
    expect(again.connection.connectionId).toBe(id);
    expect(secret(again.connection.directConnectionString)).not.toBe(first);

    yield* stack.destroy();
    yield* expectConnectionGone(id);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "recovers an interrupted create as owned and recovers credentials without creating another key",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(connectionStack({ name: "api" }));
    const name = initial.connection.connectionName;
    const before = yield* listConnections(initial.database.databaseId);
    yield* markCreating(stack, "Api");

    // The deterministic name proves ownership, so no adoption is needed.
    const recovered = yield* stack.deploy(connectionStack({ name: "api" }));
    expect(recovered.connection.connectionId).toBe(initial.connection.connectionId);
    expect(recovered.connection.connectionName).toBe(name);
    // The one-time credentials were lost with the state, so they are rotated.
    const credentials = secret(recovered.connection.directConnectionString);
    expect(credentials).toBeDefined();
    expect(credentials).not.toBe(secret(initial.connection.directConnectionString));

    const after = yield* listConnections(initial.database.databaseId);
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
    expect(after.filter((c) => c.name === name)).toHaveLength(1);

    const stable = yield* stack.deploy(connectionStack({ name: "api" }));
    expect(secret(stable.connection.directConnectionString)).toBe(credentials);

    yield* stack.destroy();
    yield* expectConnectionGone(initial.connection.connectionId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "after lost state, adoption keeps the old generated name and rotates only on request",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(connectionStack({ name: "api" }));
    const before = yield* listConnections(initial.database.databaseId);
    yield* forgetState(stack, "Api");

    // A new instance generates a different name, so the old key is foreign.
    const refused = yield* failureOf(stack.deploy(connectionStack({ name: "api" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(connectionStack({ name: "api" }, { adopt: true }));
    expect(adopted.connection.connectionId).toBe(initial.connection.connectionId);
    expect(adopted.connection.connectionName).toBe(initial.connection.connectionName);
    expect(adopted.connection.directConnectionString).toBeUndefined();
    const after = yield* listConnections(initial.database.databaseId);
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());

    const planned = yield* stack.plan(connectionStack({ name: "api" }));
    expect(planned.resources.Api?.action).toBe("noop");

    const rotated = yield* stack.deploy(connectionStack({ name: "api", rotate: true }));
    expect(rotated.connection.connectionId).toBe(initial.connection.connectionId);
    expect(rotated.connection.connectionName).toBe(initial.connection.connectionName);
    const credentials = secret(rotated.connection.directConnectionString);
    expect(credentials).toBeDefined();

    // A refresh keeps the adopted name and the rotated credentials.
    const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
      Effect.provide(stack.state),
    );
    const refreshed = detected.resources.Api;
    expect(refreshed?.attr?.connectionName).toBe(initial.connection.connectionName);
    expect(secret(refreshed?.attr?.directConnectionString)).toBe(credentials);

    yield* stack.destroy();
    yield* expectConnectionGone(initial.connection.connectionId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "requires adoption for a foreign connection with the natural name and keeps that name",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack);
    const foreign = yield* createConnection({
      databaseId: initial.database.databaseId,
      name: "api",
    });

    const refused = yield* failureOf(stack.deploy(connectionStack({ name: "api" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(connectionStack({ name: "api" }, { adopt: true }));
    expect(adopted.connection.connectionId).toBe(foreign.data.id);
    expect(adopted.connection.connectionName).toBe("api");
    expect(adopted.connection.directConnectionString).toBeUndefined();
    const named = (yield* listConnections(initial.database.databaseId)).filter((c) =>
      c.name.startsWith("api"),
    );
    expect(named.map((c) => c.id)).toEqual([foreign.data.id]);

    const rotated = yield* stack.deploy(connectionStack({ name: "api", rotate: true }));
    expect(rotated.connection.connectionId).toBe(foreign.data.id);
    expect(rotated.connection.connectionName).toBe("api");
    expect(rotated.connection.directConnectionString).toBeDefined();

    yield* stack.destroy();
    yield* expectConnectionGone(foreign.data.id);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "fails ambiguous generated-name recovery and treats a single foreign generated key as unowned",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack);
    const databaseId = initial.database.databaseId;
    const first = yield* createConnection({ databaseId, name: "api-aaaaaaaaaaaa" });
    const second = yield* createConnection({ databaseId, name: "api-bbbbbbbbbbbb" });

    const ambiguous = yield* failureOf(stack.deploy(connectionStack({ name: "api" })));
    expect(ambiguous.text).toContain("has 2 connections named");
    expect(ambiguous.text).toContain("<instance-id>");

    yield* deleteConnection({ id: second.data.id });
    yield* expectConnectionGone(second.data.id);

    const refused = yield* failureOf(stack.deploy(connectionStack({ name: "api" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(connectionStack({ name: "api" }, { adopt: true }));
    expect(adopted.connection.connectionId).toBe(first.data.id);
    expect(adopted.connection.connectionName).toBe("api-aaaaaaaaaaaa");
    expect(adopted.connection.directConnectionString).toBeUndefined();
    const named = (yield* listConnections(databaseId)).filter((c) => c.name.startsWith("api"));
    expect(named.map((c) => c.id)).toEqual([first.data.id]);

    yield* stack.destroy();
    yield* expectConnectionGone(first.data.id);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "rejects a blank connection name before calling Prisma",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack);
    const before = yield* listConnections(initial.database.databaseId);

    const failure = yield* failureOf(stack.deploy(connectionStack({ name: "   " })));
    expect(failure.text).toContain("must contain at least one non-space character");
    const after = yield* listConnections(initial.database.databaseId);
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());

    yield* stack.destroy();
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "replaces a persisted connection with a mismatched database and refuses to refresh or rotate a mismatched identity",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(connectionStack({ name: "api" }));
    const { connectionId, connectionName, databaseId } = initial.connection;
    const original = secret(initial.connection.directConnectionString);

    yield* patchStateAttr(stack, "Api", { databaseId: "database-foreign" });
    const planned = yield* stack.plan(connectionStack({ name: "api" }));
    expect(planned.resources.Api?.action).toBe("replace");
    yield* patchStateAttr(stack, "Api", { databaseId });

    // Persisted name no longer matches the cloud: a refresh refuses.
    yield* patchStateAttr(stack, "Api", { connectionName: "api" });
    const refresh = yield* failureOf(
      Drift.detect({ name: stack.name, stage: stack.stage }).pipe(Effect.provide(stack.state)),
    );
    const refreshError = refresh.errors.find(
      (error): error is Drift.DriftResourceError => error instanceof Drift.DriftResourceError,
    );
    expect(refreshError).toBeDefined();
    expect(String(refreshError?.cause)).toContain("no longer matches persisted");
    expect(String(refreshError?.cause)).toContain("name 'api'");

    // A generated-looking name for a different instance: rotation refuses.
    yield* patchStateAttr(stack, "Api", { connectionName: "api-000000000000" });
    const rotate = yield* failureOf(stack.deploy(connectionStack({ name: "api", rotate: true })));
    expect(rotate.text).toContain("mismatched identity");
    yield* restoreRowAttr(stack, "Api", { connectionName });

    const observed = yield* observeConnection(connectionId);
    expect(observed.name).toBe(connectionName);
    expect(observed.database.id).toBe(databaseId);
    const settled = yield* stack.deploy(connectionStack({ name: "api" }));
    expect(settled.connection.connectionId).toBe(connectionId);
    expect(secret(settled.connection.directConnectionString)).toBe(original);

    yield* stack.destroy();
    yield* expectConnectionGone(connectionId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

it(
  "does not collide binding keys after lossy normalization",
  () => {
    const hyphenated = connectEnvKeys({ FQN: "db-a", LogicalId: "db-a" });
    const underscored = connectEnvKeys({ FQN: "db_a", LogicalId: "db_a" });

    expect(hyphenated.directConnectionString).not.toBe(underscored.directConnectionString);
  },
  { tags: ["unit", "provider:prisma", "provider:prisma:connect", "local"] },
);
