import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Daytona.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { executeWhenReady } = Test;

const run = (url: string, command: string) =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/run`).pipe(HttpClientRequest.bodyText(command)),
  ).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { result: string; exitCode: number }),
  );

test(
  "starts each sandbox from the Warm snapshot",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* run(url, "node -p \"require('./package.json').name\"");
    expect(repo).toMatchObject({ exitCode: 0 });
    expect(repo.result.trim()).toBe("@sindresorhus/is");
    const node = yield* run(url, "node --version");
    expect(node.result).toMatch(/^v24\./);
  }),
  { timeout: 300_000 },
);

test(
  "keeps a user's changes in their own sandbox",
  Effect.gen(function* () {
    const { url, snapshot } = yield* stack;
    // Derived from the stage-scoped snapshot name, so stages never share a user.
    const user = snapshot
      .slice(-8)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const put = yield* executeWhenReady(
      HttpClientRequest.put(`${url}/users/${user}/files/notes.md`).pipe(
        HttpClientRequest.bodyText("hello"),
      ),
    );
    const first = (yield* put.json) as { sandboxId: string; content: string };
    expect(first.content).toBe("hello");

    const get = yield* HttpClient.execute(
      HttpClientRequest.get(`${url}/users/${user}/files/notes.md`),
    );
    const second = (yield* get.json) as { sandboxId: string; content: string };
    expect(second.sandboxId).toBe(first.sandboxId);

    // A fresh sandbox from Warm doesn't have the user's change.
    const fresh = yield* run(url, "test -f notes.md && echo yes || echo no");
    expect(fresh.result.trim()).toBe("no");

    // The user's sandbox was created at runtime: delete it through the API.
    const removed = yield* HttpClient.execute(HttpClientRequest.delete(`${url}/users/${user}`));
    expect(removed.status).toBe(204);
  }),
  { timeout: 300_000 },
);
