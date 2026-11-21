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
import ClankaApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClankaCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* ClankaApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot, which installs clanka.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:clanka", "provider:boat", "live"];

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
      .get(`${url}/warm/up/history`)
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

test(
  "clanka's loop runs in the Durable Object and its scripts in a Boat sandbox",
  Effect.gen(function* () {
    const object = `user-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/${object}/work/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    yield* Effect.gen(function* () {
      // Each script is given whole: the test is of clanka's plumbing, not of what a model writes.
      const run = (script: string) =>
        call(`/${object}/work/prompt`, {
          text: `Run exactly this script with the execute tool, unchanged:\n\n${script}`,
        });

      // clanka's own functions work on the sandbox's files.
      yield* run(
        'await writeFile({ path: "/home/user/alpha.txt", content: "needle-7391" });\nawait taskComplete("written");',
      );
      const file = yield* call(`/${object}/work/file`, { path: "/home/user/alpha.txt" });
      expect(file.text).toContain("needle-7391");

      // A tool of ours runs in the Durable Object and is called from a script in the sandbox.
      const looked = yield* run(
        'const result = await lookupCode({ word: "teal" });\nawait taskComplete(result.code);',
      );
      expect(looked.summary).toContain("CODE-TEAL-7391");

      // The conversation was saved: a new instance has it.
      yield* call(`/${object}/work/crash`, {}).pipe(Effect.ignore);
      const history = yield* call(`/${object}/work/history`);
      // Both scripts are in it, as the model sent them.
      expect(JSON.stringify(history.content)).toContain("needle-7391");
      expect(JSON.stringify(history.content)).toContain("lookupCode");
      expect(
        (history.content as ReadonlyArray<{ role: string }>).filter(
          (message) => message.role === "user",
        ).length,
      ).toBeGreaterThanOrEqual(2);

      // Suspending twice is the same as once, and the next prompt finds the file.
      yield* call(`/${object}/work/suspend`, {});
      yield* call(`/${object}/work/suspend`, {});
      expect((yield* stateBecomes("paused")).state).toBe("paused");
      const read = yield* run(
        'const text = await readFile({ path: "/home/user/alpha.txt" });\nawait taskComplete(String(text));',
      );
      expect(read.summary).toContain("needle-7391");

      // Removing twice is the same as once.
      yield* call(`/${object}/work/remove`, {});
      yield* call(`/${object}/work/remove`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${object}/work/remove`, {}))));
  }),
  { tags, timeout: 600_000 },
);
