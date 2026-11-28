import { expect } from "bun:test";
import * as Render from "@alchemy.run/render";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Render.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200 ? Effect.succeed(res) : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys a Render Project and WebService and serves HTTP 200 on *.onrender.com",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.projectId).toMatch(/^prj-/);
    expect(out.serviceId).toMatch(/^srv-/);
    expect(out.url).toMatch(/^https:\/\/.+\.onrender\.com$/);

    const response = yield* fetchOk(out.url!);
    expect(response.status).toBe(200);
  }),
  { timeout: 120_000 },
);
