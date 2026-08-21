import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";
import type { User } from "../src/schema.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Fly.providers(), Drizzle.providers()),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 20,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "Service connects to Managed Postgres through Drizzle",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.clusterId).toBeString();
    expect(out.region).toBe("iad");
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    const health = yield* fetchOk(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean; users: number };
    expect(body.ok).toBe(true);
    expect(body.users).toBeNumber();

    const created = yield* HttpClient.execute(
      HttpClientRequest.post(`${out.apiUrl}/users`),
    );
    expect(created.status).toBe(200);
    const createdBody = (yield* created.json) as { user: User[] };
    expect(createdBody.user).toHaveLength(1);
    expect(createdBody.user[0]?.id).toBeNumber();
  }),
  { timeout: 240_000 },
);
