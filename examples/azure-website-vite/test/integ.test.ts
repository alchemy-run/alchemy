import * as Alchemy from "alchemy";
import * as Azure from "alchemy/Azure";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

test(
  "SPA renders the Azure heading",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (!url) throw new Error("expected the site to expose a url");
    const base = String(url).replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;
    const body = yield* client.get(`${base}/`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.text
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
    );
    expect(body).toContain("Hello — Azure");
  }),
  { timeout: 120_000 },
);
