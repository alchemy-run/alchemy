import {
  closePrismaDevDatabase,
  ensurePrismaDevDatabase,
} from "@/Prisma/PrismaDevDatabase";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Client } from "pg";

const toError = (message: string) => (cause: unknown) =>
  cause instanceof Error ? cause : new Error(`${message}: ${String(cause)}`);

const queryAnswer = Effect.fn(function* (connectionString: string) {
  const client = yield* Effect.sync(() => new Client({ connectionString }));
  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: toError("Failed to connect to local Prisma database"),
  });
  return yield* Effect.tryPromise({
    try: () => client.query("select 42::int as answer"),
    catch: toError("Failed to query local Prisma database"),
  }).pipe(
    Effect.map((result) => Number(result.rows[0]?.answer)),
    Effect.ensuring(
      Effect.tryPromise({
        try: () => client.end(),
        catch: toError("Failed to close local Prisma database client"),
      }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

describe("Prisma dev database", () => {
  it.effect(
    "starts @prisma/dev and returns usable direct and pooled URLs",
    () => {
      const basePort = 58000 + (process.pid % 1000);
      const databaseId = `dev:database:test-${process.pid}`;

      return Effect.gen(function* () {
        const attrs = yield* ensurePrismaDevDatabase(databaseId, {
          provider: "@prisma/dev",
          persistenceMode: "stateless",
          port: basePort,
          databasePort: basePort + 1,
          shadowDatabasePort: basePort + 2,
        });

        expect(attrs).toBeDefined();
        const direct = Redacted.value(attrs!.directConnectionString);
        const pooled = Redacted.value(attrs!.pooledConnectionString);

        expect(direct).toContain("127.0.0.1");
        expect(pooled).toMatch(/^prisma\+postgres:\/\//);
        expect(attrs!.host).toBe("127.0.0.1");

        const answer = yield* queryAnswer(direct);
        expect(answer).toBe(42);
      }).pipe(
        Effect.ensuring(closePrismaDevDatabase(databaseId)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    },
  );
});
