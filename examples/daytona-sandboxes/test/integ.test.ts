import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Daytona.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { executeWhenReady } = Test;

test(
  "runs a command in a fresh sandbox",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* executeWhenReady(
      HttpClientRequest.post(`${url}/run`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ command: "node --version" }),
      ),
    );
    const body = (yield* response.json) as { exitCode: number; result: string };
    expect(body.exitCode).toBe(0);
    expect(body.result).toMatch(/^v22\./);
  }),
  { timeout: 300_000 },
);

test(
  "keeps a user's files on their volume across sandboxes",
  Effect.gen(function* () {
    const { url, snapshot } = yield* stack;
    // Derived from the stage-scoped snapshot name, so stages never share a user.
    const user = snapshot.slice(-8).toLowerCase();
    const visit = HttpClient.execute(HttpClientRequest.put(`${url}/users/${user}/sandbox`)).pipe(
      Effect.flatMap((r) => r.json),
      Effect.map((b) => (b as { visits: number }).visits),
    );
    expect(yield* visit).toBe(1);
    expect(yield* visit).toBe(2);
    // A new sandbox mounts the same volume, so the visits carry over.
    yield* HttpClient.execute(HttpClientRequest.delete(`${url}/users/${user}/sandbox`));
    expect(yield* visit).toBe(3);
    // Runtime objects outlive the stack: remove the user's sandbox and volume.
    // The volume frees up about a minute after the sandbox is deleted.
    const removed = yield* HttpClient.execute(
      HttpClientRequest.delete(`${url}/users/${user}`),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (r) => r.status !== 409,
        times: 12,
      }),
    );
    expect(removed.status).toBe(204);
  }),
  { timeout: 600_000 },
);
