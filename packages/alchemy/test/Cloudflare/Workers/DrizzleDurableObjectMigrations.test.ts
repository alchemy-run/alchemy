import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import DrizzleDurableObjectWorker from "./fixtures/drizzle-do/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

/**
 * End-to-end coverage for drizzle-kit's Durable Object migrations flow: the
 * checked-in `fixtures/drizzle-do/drizzle/` directory is exactly what
 * `drizzle-kit generate` emits for `driver: "durable-sqlite"` — a
 * `migrations.js` importing each migration's `.sql` file — and the DO runs
 * `drizzle-orm/durable-sqlite`'s `migrate` at instance init. The deploy
 * itself asserts the bundler resolves bare `.sql` imports as text modules.
 */
const Stack = Alchemy.Stack(
  "DrizzleDurableObjectMigrationsStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* DrizzleDurableObjectWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

test(
  "DO runs drizzle migrations at init and serves drizzle queries",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // A fresh instance name per run so the migrated table starts empty
    // even when the stack is kept alive between runs (NO_DESTROY).
    const instance = crypto.randomUUID();

    const post = yield* client
      .post(`${url}/users?do=${instance}&name=gimli`)
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
        ),
        Effect.retry({ schedule: readinessSchedule, times: 15 }),
      );
    expect(post.status).toBe(200);

    yield* client.post(`${url}/users?do=${instance}&name=legolas`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`add user failed: ${res.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 5 }),
    );

    const res = yield* client.get(`${url}/users?do=${instance}`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { names: string[] };
    expect(body.names).toEqual(["gimli", "legolas"]);
  }),
  { timeout: 120_000 },
);
