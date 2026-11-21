import { expect } from "bun:test";
// test/dev.test.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
  state: Alchemy.localState(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "a message written through the Worker reads back",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const ready = yield* Test.getWhenReady(url);
    expect(ready.status).toBe(200);

    const response = yield* HttpClient.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText("hello")),
    );
    const messages = (yield* response.json) as Array<{ body: string }>;
    expect(messages.map((message) => message.body)).toContain("hello");
  }),
  { timeout: 120_000 },
);
