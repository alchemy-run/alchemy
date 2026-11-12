import { expect } from "bun:test";
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), ClickHouseCloud.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const getJson = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* Test.executeWhenReady(HttpClientRequest.get(`${url}${path}`));
    expect(res.status).toBe(200);
    return (yield* res.json) as A;
  });

test(
  "reports the last week's spend per service and day",
  Effect.gen(function* () {
    const usage = yield* getJson<{ total: number; days: { date: string; credits: number }[] }>(
      "/usage?days=7",
    );
    expect(usage.total).toBeGreaterThanOrEqual(0);
    for (const day of usage.days) expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }),
  { timeout: 120_000 },
);

test(
  "reports the credits left",
  Effect.gen(function* () {
    const credits = yield* getJson<{ remaining: number }>("/credits");
    expect(typeof credits.remaining).toBe("number");
  }),
  { timeout: 120_000 },
);

test(
  "lists the organization's notifications",
  Effect.gen(function* () {
    const feed = yield* getJson<{ type: string }[]>("/notifications");
    expect(Array.isArray(feed)).toBe(true);
  }),
  { timeout: 120_000 },
);
