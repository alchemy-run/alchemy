import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

/**
 * The binding suites deploy a Cloudflare Worker host, so they need
 * Cloudflare credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or
 * CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE=1 when the selected profile has
 * Cloudflare configured (a profile can't be inspected before tests
 * register, so it is opted into explicitly).
 */
export const noCloudflare =
  !process.env.CLOUDFLARE_ACCOUNT_ID && !process.env.CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE;

export const bindingTags = [
  "provider:clickhouse-cloud",
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "live",
];

/**
 * GET a route of the deployed Worker and return its JSON body. A route
 * that fails answers 500 with `{ error }`, which fails the assertion with
 * the cause.
 */
export const getJson =
  (stack: Effect.Effect<{ readonly url: string }, unknown>) =>
  <A>(path: string) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      // A fresh workers.dev URL answers 404 until it propagates.
      const client = HttpClient.filterStatus(
        yield* HttpClient.HttpClient,
        (status) => status !== 404,
      );
      const res = yield* client
        .get(`${url}${path}`)
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      const body = (yield* res.json) as A & { error?: string };
      expect(body.error).toBeUndefined();
      expect(res.status).toBe(200);
      return body;
    });
