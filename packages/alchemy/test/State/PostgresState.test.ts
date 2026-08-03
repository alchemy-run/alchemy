import {
  makePostgresState,
  type PostgresStateClient,
  type PostgresStateConnection,
  type PostgresStateOptions,
} from "@/State/PostgresState";
import { StateStoreError, type StateService } from "@/State/State";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

interface FakeQuery {
  text: string;
  values: unknown[];
}

interface FakeConnection extends PostgresStateConnection {
  queries: FakeQuery[];
  released: boolean;
}

/**
 * Hermetic fake of the small `pg` surface the store uses. It recognizes the
 * store's fixed SQL statements and keeps rows in in-memory maps, so tests
 * exercise the real store logic (lock acquisition, lease guard, encoding)
 * without a database. Every checked-out connection records its own queries
 * separately from the pool, so tests can prove which connection ran what —
 * in particular that the lease re-verification never touches the reserved
 * lock connection.
 */
const makeFakePostgres = () => {
  const resources = new Map<string, unknown>();
  const outputs = new Map<string, unknown>();
  const poolQueries: FakeQuery[] = [];
  const connections: FakeConnection[] = [];
  const control = {
    lockAcquired: true,
    lockLive: true,
    lockQueries: 0,
  };

  const resourceKey = (stack: unknown, stage: unknown, fqn: unknown) =>
    `${stack} ${stage} ${fqn}`;
  const outputKey = (stack: unknown, stage: unknown) => `${stack} ${stage}`;

  const handle = async (
    text: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    const sql = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }
    if (sql.includes("pg_try_advisory_lock")) {
      control.lockQueries += 1;
      return { rows: [{ acquired: control.lockAcquired, pid: 42 }] };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [{}] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      return { rows: [{}] };
    }
    if (sql.includes("from pg_locks")) {
      return { rows: [{ live: control.lockLive }] };
    }
    if (sql.startsWith("create table")) {
      return { rows: [] };
    }
    if (sql.startsWith("insert into alchemy_resource_state")) {
      const [stack, stage, fqn, json] = values;
      resources.set(resourceKey(stack, stage, fqn), JSON.parse(String(json)));
      return { rows: [] };
    }
    if (sql.startsWith("insert into alchemy_stack_output")) {
      const [stack, stage, json] = values;
      outputs.set(outputKey(stack, stage), JSON.parse(String(json)));
      return { rows: [] };
    }
    if (sql.includes("value ->> 'status'")) {
      const [stack, stage] = values;
      const rows = Array.from(resources.entries())
        .filter(([key]) => key.startsWith(`${stack} ${stage} `))
        .map(([, value]) => ({ value }))
        .filter(
          (row) =>
            (row.value as { status?: string } | undefined)?.status ===
            "replaced",
        );
      return { rows };
    }
    if (sql.startsWith("select value from alchemy_resource_state")) {
      const [stack, stage, fqn] = values;
      const value = resources.get(resourceKey(stack, stage, fqn));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith("select value from alchemy_stack_output")) {
      const [stack, stage] = values;
      const value = outputs.get(outputKey(stack, stage));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith("select fqn from alchemy_resource_state")) {
      const [stack, stage] = values;
      const rows = Array.from(resources.keys())
        .filter((key) => key.startsWith(`${stack} ${stage} `))
        .map((key) => ({ fqn: key.split(" ")[2] }))
        .sort((a, b) => String(a.fqn).localeCompare(String(b.fqn)));
      return { rows };
    }
    if (sql.startsWith("select stack from alchemy_resource_state")) {
      const stacks = new Set<string>();
      for (const key of resources.keys()) stacks.add(key.split(" ")[0]!);
      for (const key of outputs.keys()) stacks.add(key.split(" ")[0]!);
      return {
        rows: Array.from(stacks)
          .sort()
          .map((stack) => ({ stack })),
      };
    }
    if (sql.startsWith("select stage from alchemy_resource_state")) {
      const [stack] = values;
      const stages = new Set<string>();
      for (const key of resources.keys()) {
        const [s, stage] = key.split(" ");
        if (s === stack) stages.add(stage!);
      }
      for (const key of outputs.keys()) {
        const [s, stage] = key.split(" ");
        if (s === stack) stages.add(stage!);
      }
      return {
        rows: Array.from(stages)
          .sort()
          .map((stage) => ({ stage })),
      };
    }
    if (sql.startsWith("delete from alchemy_resource_state")) {
      const [stack, stage, fqn] = values;
      if (fqn !== undefined) {
        resources.delete(resourceKey(stack, stage, fqn));
      } else if (stage !== undefined) {
        for (const key of Array.from(resources.keys())) {
          if (key.startsWith(`${stack} ${stage} `)) {
            resources.delete(key);
          }
        }
      } else {
        for (const key of Array.from(resources.keys())) {
          if (key.startsWith(`${stack} `)) resources.delete(key);
        }
      }
      return { rows: [] };
    }
    if (sql.startsWith("delete from alchemy_stack_output")) {
      const [stack, stage] = values;
      for (const key of Array.from(outputs.keys())) {
        const [s, keyStage] = key.split(" ");
        if (s === stack && (stage === undefined || keyStage === stage)) {
          outputs.delete(key);
        }
      }
      return { rows: [] };
    }
    throw new Error(`fake postgres does not recognize: ${sql}`);
  };

  const connect = async (): Promise<PostgresStateConnection> => {
    const queries: FakeQuery[] = [];
    const connection: FakeConnection = {
      queries,
      released: false,
      query: (text, values = []) => {
        queries.push({ text, values });
        return handle(text, values);
      },
      release: () => {
        connection.released = true;
      },
    };
    connections.push(connection);
    return connection;
  };

  const client: PostgresStateClient = {
    query: (text, values = []) => {
      poolQueries.push({ text, values });
      return handle(text, values);
    },
    connect,
  };
  return { client, poolQueries, connections, resources, outputs, control };
};

const connectionRunning = (
  connections: FakeConnection[],
  fragment: string,
): FakeConnection | undefined =>
  connections.find((connection) =>
    connection.queries.some((query) => query.text.includes(fragment)),
  );

const withStore = <A, E>(
  options: PostgresStateOptions,
  use: (store: StateService) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const store = yield* makePostgresState(options, scope);
    return yield* use(store);
  }).pipe(Effect.scoped);

const request = { stack: "app", stage: "prod", fqn: "app/prod/db" };

const sampleState = {
  kind: "resource",
  status: "created",
  logicalId: "db",
  output: { password: Redacted.make("s3cret") },
} as never;

describe("Postgres state store", () => {
  it.effect("requires exactly one of client or dsn", () => {
    const fake = makeFakePostgres();
    return Effect.gen(function* () {
      const neither = yield* withStore({}, (store) => store.get(request)).pipe(
        Effect.flip,
      );
      expect(neither).toBeInstanceOf(StateStoreError);
      expect(neither.message).toContain("exactly one of `client` or `dsn`");

      const both = yield* withStore(
        { client: fake.client, dsn: "postgres://localhost/state" },
        (store) => store.get(request),
      ).pipe(Effect.flip);
      expect(both.message).toContain("exactly one of `client` or `dsn`");
    });
  });

  it.effect("round-trips resource state including Redacted values", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        expect(yield* store.get(request)).toBeUndefined();

        yield* store.set({ ...request, value: sampleState });
        const revived = (yield* store.get(request)) as {
          status: string;
          output: { password: Redacted.Redacted<string> };
        };

        expect(revived.status).toBe("created");
        expect(Redacted.isRedacted(revived.output.password)).toBe(true);
        expect(Redacted.value(revived.output.password)).toBe("s3cret");

        // The jsonb column stores the encoded (redaction-marked) form, so
        // the raw secret round-trips through encodeState, not plain JSON.
        const stored = fake.resources.get("app prod app/prod/db");
        expect(JSON.stringify(stored)).toContain("__redacted__");
      }),
    );
  });

  it.effect("serializes the schema migration under an advisory lock", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.get(request);

        const migration = connectionRunning(fake.connections, "create table");
        expect(migration).toBeDefined();
        const statements = migration!.queries.map((query) =>
          query.text.replaceAll(/\s+/g, " ").trim().toLowerCase(),
        );
        expect(statements[0]).toBe("begin");
        expect(statements[1]).toContain("pg_advisory_xact_lock");
        expect(migration!.queries[1]?.values).toEqual(["alchemy:schema"]);
        expect(statements[2]).toContain(
          "create table if not exists alchemy_resource_state",
        );
        expect(statements[3]).toContain(
          "create table if not exists alchemy_stack_output",
        );
        expect(statements[4]).toBe("commit");
        expect(migration!.released).toBe(true);
      }),
    );
  });

  it.effect("acquires the advisory lock once per stack/stage", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.get(request);
        yield* store.list(request);
        yield* store.setOutput({ ...request, value: { url: "https://x" } });
        expect(yield* store.getOutput(request)).toEqual({ url: "https://x" });

        expect(fake.control.lockQueries).toBe(1);
        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.queries[0]?.values).toEqual(["alchemy:app/prod"]);
      }),
    );
  });

  it.effect(
    "re-verifies the lease from the pool, never the lock connection",
    () => {
      const fake = makeFakePostgres();
      return withStore({ client: fake.client, leaseCheckTtlMs: 0 }, (store) =>
        Effect.gen(function* () {
          yield* store.set({ ...request, value: sampleState });
          yield* store.get(request);

          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock).toBeDefined();
          // The reserved connection only ever takes the lock; the liveness
          // check must ask a different backend via the pool, because the
          // reserved connection cannot reliably report on itself once its
          // backend has been killed server-side.
          expect(
            lock!.queries.some((query) => query.text.includes("pg_locks")),
          ).toBe(false);
          expect(
            fake.poolQueries.some((query) => query.text.includes("pg_locks")),
          ).toBe(true);
        }),
      );
    },
  );

  it.effect("prefixes the lock key with lockKeyPrefix", () => {
    const fake = makeFakePostgres();
    return withStore(
      { client: fake.client, lockKeyPrefix: "my-app" },
      (store) =>
        Effect.gen(function* () {
          yield* store.get(request);
          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock?.queries[0]?.values).toEqual(["my-app:app/prod"]);
        }),
    );
  });

  it.effect("fails immediately when another deploy holds the lock", () => {
    const fake = makeFakePostgres();
    fake.control.lockAcquired = false;
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        const result = yield* store.get(request).pipe(Effect.flip);
        expect(result).toBeInstanceOf(StateStoreError);
        expect(result.message).toContain(
          "another deploy holds the Postgres state lock",
        );
        // The reserved connection goes back to the pool on contention.
        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.released).toBe(true);
      }),
    );
  });

  it.effect("unlocks and releases the lock connection on scope close", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      store.set({ ...request, value: sampleState }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock).toBeDefined();
          expect(
            lock!.queries.some((query) =>
              query.text.includes("pg_advisory_unlock"),
            ),
          ).toBe(true);
          expect(lock!.released).toBe(true);
        }),
      ),
    );
  });

  it.effect("fails loudly when the lock lease is lost mid-run", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client, leaseCheckTtlMs: 0 }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });

        fake.control.lockLive = false;
        const result = yield* store.get(request).pipe(Effect.flip);
        expect(result).toBeInstanceOf(StateStoreError);
        expect(result.message).toContain("was lost mid-run");

        // Stage-less operations re-verify held leases too.
        const listResult = yield* store.listStacks().pipe(Effect.flip);
        expect(listResult.message).toContain("was lost mid-run");
      }),
    );
  });

  it.effect("filters replaced resources in SQL", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.set({
          ...request,
          fqn: "app/prod/old",
          value: { ...(sampleState as object), status: "replaced" } as never,
        });

        const replaced = yield* store.getReplacedResources(request);
        expect(replaced).toHaveLength(1);
        expect(replaced[0]?.status).toBe("replaced");
      }),
    );
  });

  it.effect("lists stacks, stages, and fqns", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.set({
          ...request,
          fqn: "app/prod/api",
          value: sampleState,
        });
        yield* store.setOutput({
          stack: "other",
          stage: "dev",
          value: { ok: true },
        });

        expect(yield* store.listStacks()).toEqual(["app", "other"]);
        expect(yield* store.listStages("app")).toEqual(["prod"]);
        expect(yield* store.list(request)).toEqual([
          "app/prod/api",
          "app/prod/db",
        ]);
      }),
    );
  });

  it.effect("deleteStack removes resource rows and stack outputs", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.setOutput({ ...request, value: { ok: true } });

        yield* store.deleteStack({ stack: "app", stage: "prod" });
        expect(yield* store.get(request)).toBeUndefined();
        expect(yield* store.getOutput(request)).toBeUndefined();

        yield* store.set({ ...request, value: sampleState });
        yield* store.deleteStack({ stack: "app" });
        expect(fake.resources.size).toBe(0);
        expect(fake.outputs.size).toBe(0);
      }),
    );
  });

  it.effect("stage-less deleteStack locks every stage before deleting", () => {
    const fake = makeFakePostgres();
    // Rows written by an earlier run: this store has not touched the stack
    // yet, so it holds no leases when deleteStack starts.
    fake.resources.set("app prod app/prod/db", { status: "created" });
    fake.outputs.set("app prod", { ok: true });

    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.deleteStack({ stack: "app" });

        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.queries[0]?.values).toEqual(["alchemy:app/prod"]);
        expect(fake.resources.size).toBe(0);
        expect(fake.outputs.size).toBe(0);
      }),
    );
  });

  it.effect("delete removes a single resource", () => {
    const fake = makeFakePostgres();
    return withStore({ client: fake.client }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.delete(request);
        expect(yield* store.get(request)).toBeUndefined();
      }),
    );
  });
});
