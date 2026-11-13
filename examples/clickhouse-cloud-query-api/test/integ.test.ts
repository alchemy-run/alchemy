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

const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_800_000 });

const getJson = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* Test.executeWhenReady(HttpClientRequest.get(`${url}${path}`));
    expect(res.status).toBe(200);
    return (yield* res.json) as A;
  });

test(
  "serves the hottest stations from the Query API endpoint",
  Effect.gen(function* () {
    const rows = yield* getJson<{ station: string; avg: number }[]>("/hottest?n=3");
    expect(rows.length).toBe(3);
    // The loaded CSV's hottest station.
    expect(rows[0]).toEqual({ station: "Assab", avg: 30.5 });
    expect(rows[0]!.avg).toBeGreaterThanOrEqual(rows[1]!.avg);
    expect(rows[1]!.avg).toBeGreaterThanOrEqual(rows[2]!.avg);
  }),
  { timeout: 120_000 },
);

test(
  "reads the service's state",
  Effect.gen(function* () {
    expect(yield* getJson<{ state: string }>("/status")).toEqual({ state: "running" });
  }),
  { timeout: 120_000 },
);
