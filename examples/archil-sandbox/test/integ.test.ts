import { expect } from "bun:test";
import * as Archil from "@alchemy.run/archil";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Archil.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

const user = `user-${Test.defaultStage()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/** A fresh hostname (or a waking sandbox) can take a few seconds to answer. */
const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status >= 500 ? Effect.fail(new Error(`HTTP ${res.status}`)) : Effect.succeed(res),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
    );
  });

const post = (url: string, command: string) =>
  send(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(command))).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { stdout: string; exitCode: number }),
  );

test(
  "forks Golden for each request",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const name = yield* post(`${url}/run`, "grep -o '\"@sindresorhus/is\"' package.json");
    expect(name).toMatchObject({ stdout: '"@sindresorhus/is"\n', exitCode: 0 });
    const both = yield* post(`${url}/run`, "ls ..");
    expect(both.stdout).toContain("slugify");
  }),
  { timeout: 300_000 },
);

test(
  "gives each user a fork of their own",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const put = yield* send(
      HttpClientRequest.put(`${url}/users/${user}/files/notes.md`).pipe(
        HttpClientRequest.bodyText("hello"),
      ),
    );
    const first = (yield* put.json) as { sandboxId: string; content: string };
    expect(first.content).toBe("hello");

    const get = yield* send(HttpClientRequest.get(`${url}/users/${user}/files/notes.md`));
    const second = (yield* get.json) as { sandboxId: string; content: string };
    expect(second.sandboxId).toBe(first.sandboxId);

    // A fresh fork of Golden doesn't have the user's change.
    const fresh = yield* post(`${url}/run`, "test -f notes.md && echo yes || echo no");
    expect(fresh.stdout).toBe("no\n");

    // The user's fork was created at runtime: delete it through the API.
    const removed = yield* send(HttpClientRequest.delete(`${url}/users/${user}`));
    expect(removed.status).toBe(204);
  }),
  { timeout: 300_000 },
);
