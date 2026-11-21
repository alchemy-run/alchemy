import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import NanocodeApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "NanocodeCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* NanocodeApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot and uploads nanocode's WebAssembly module.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:nanocode", "live"];

/** Call the fixture's API once it serves; a failure says what the fixture answered. */
const call = (path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const request =
      body === undefined
        ? HttpClientRequest.get(`${url}${path}`)
        : HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    // A fresh workers.dev URL answers 404 or 5xx for its first seconds.
    yield* HttpClient.filterStatusOk(client)
      .get(`${url}/warm/up/state`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      const text = yield* response.text;
      return yield* Effect.die(
        new Error(`${path} returned ${response.status}: ${text.slice(0, 3000)}`),
      );
    }
    return (yield* response.json) as any;
  });

type Logged = { readonly type: string; readonly tool?: string };

test(
  "nanocode runs in the Durable Object on the harness's model and tools, and its journal outlives the instance",
  Effect.gen(function* () {
    const object = `user-${Date.now()}`;
    const first = yield* call(`/${object}/codes/prompt`, {
      text: 'Look up the secret code for the word "teal" with the lookup_code tool, then reply with the code.',
      requestId: "turn-1",
    });
    // A code the model cannot know without the tool.
    expect(first.message).toContain("CODE-TEAL-7391");
    const events = (yield* call(`/${object}/codes/events`)) as ReadonlyArray<Logged>;
    expect(
      events.some((event) => event.type === "tool.result" && event.tool === "lookup_code"),
    ).toBe(true);

    // The same request id is the same turn: nothing runs twice.
    const again = yield* call(`/${object}/codes/prompt`, {
      text: 'Look up the secret code for the word "teal" with the lookup_code tool, then reply with the code.',
      requestId: "turn-1",
    });
    expect(again.message).toBe(first.message);
    const after = (yield* call(`/${object}/codes/events`)) as ReadonlyArray<Logged>;
    expect(after.filter((event) => event.type === "tool.result")).toHaveLength(
      events.filter((event) => event.type === "tool.result").length,
    );

    // The session was journaled: a new instance continues it.
    yield* call(`/${object}/codes/crash`, {}).pipe(Effect.ignore);
    const remembered = yield* call(`/${object}/codes/prompt`, {
      text: "What code did the lookup_code tool give you before? Reply with the code only, and do not call a tool.",
      requestId: "turn-2",
    });
    expect(remembered.message).toContain("CODE-TEAL-7391");
  }),
  { tags, timeout: 300_000 },
);

test(
  "nanocode's own shell tool runs in the session's Boat sandbox, which is removed",
  Effect.gen(function* () {
    const object = `sbx-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/${object}/files/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    yield* Effect.gen(function* () {
      const ran = yield* call(`/${object}/files/prompt`, {
        text: "Run this shell command once with your command tool, exactly as written, then reply with what it printed: echo needle-7391 > /home/user/alpha.txt && cat /home/user/alpha.txt",
        requestId: "turn-1",
      });
      expect(ran.message).toContain("needle-7391");
      const file = yield* call(`/${object}/files/file`, { path: "/home/user/alpha.txt" });
      expect(file.text).toContain("needle-7391");

      // Removing twice is the same as once.
      yield* call(`/${object}/files/remove`, {});
      yield* call(`/${object}/files/remove`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${object}/files/remove`, {}))));
  }),
  { tags: [...tags, "provider:boat"], timeout: 300_000 },
);
