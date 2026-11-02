import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

/** A request that has to answer `status`, retried while a fresh function and its login settle. */
const expectStatus = (request: HttpClientRequest.HttpClientRequest, status: number) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.succeed(response)
        : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-postgres", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, instanceId } = deployed;

      const instance = yield* postgres.getInstance({ projectId, region, instanceId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (state) => state === "gone",
          times: 12,
        }),
        Effect.provide(StackitCloud),
      );
      expect(instance).toEqual("gone");
    }),
    { timeout: 2_700_000 },
  );

  test(
    "the deploy applied the migration, and the user owns the database",
    Effect.gen(function* () {
      const {
        projectId,
        region,
        instanceId,
        databaseId,
        databaseName,
        userName,
        migrationsHashes,
      } = yield* stack;
      expect(Object.keys(migrationsHashes)).toEqual(["0001_create_todos.sql"]);

      const database = yield* postgres
        .getDatabase({ projectId, region, instanceId, databaseId })
        .pipe(Effect.provide(StackitCloud));
      expect(database.name).toEqual(databaseName);
      expect(database.owner).toEqual(userName);
    }),
    { timeout: 120_000 },
  );

  test(
    "the function writes to and reads from the migrated table",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const created = yield* expectStatus(
        HttpClientRequest.post(`${url}/todos`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "apply migrations" }),
        ),
        201,
      );
      const todo = (yield* created.json) as unknown as Todo;
      expect(todo).toMatchObject({ title: "apply migrations", done: false });

      const read = yield* expectStatus(HttpClientRequest.get(`${url}/todos/${todo.id}`), 200);
      expect((yield* read.json) as unknown as Todo).toEqual(todo);

      const listed = yield* expectStatus(HttpClientRequest.get(`${url}/todos`), 200);
      expect((yield* listed.json) as unknown as Todo[]).toContainEqual(todo);
    }),
    { timeout: 300_000 },
  );

  test(
    "rejects an invalid todo",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* expectStatus(
        HttpClientRequest.post(`${url}/todos`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "" }),
        ),
        400,
      );
    }),
    { timeout: 300_000 },
  );
});
