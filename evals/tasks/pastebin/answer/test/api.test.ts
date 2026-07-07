/**
 * Oracle's own live tests — the pattern agents are required to follow:
 * Test.make + one shared beforeAll(deploy) + skipIf(NO_DESTROY) afterAll.
 */
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: process.env.STAGE ?? "test",
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body));

test(
  "create then read back a paste",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const create = yield* client
      .execute(postJson(`${url}/pastes`, { content: "hello world" }))
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(create.status).toBe(201);
    const created = (yield* create.json) as { id: string; url: string };
    expect(created.id.length).toBeGreaterThanOrEqual(8);

    const read = yield* client.get(`${url}/pastes/${created.id}`);
    expect(read.status).toBe(200);
    const paste = (yield* read.json) as { content: string; createdAt: string };
    expect(paste.content).toBe("hello world");
    expect(Number.isNaN(Date.parse(paste.createdAt))).toBe(false);
  }),
  { timeout: 240_000 },
);

test(
  "unknown paste id returns 404 not_found",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .get(`${url}/pastes/doesnotexist99`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );
    expect(response.status).toBe(404);
    const body = (yield* response.json) as { error: string };
    expect(body.error).toBe("not_found");
  }),
  { timeout: 240_000 },
);
