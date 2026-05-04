import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const repoName = `tutorial-${Date.now().toString(36)}`;

test(
  "create + star + patch + read combined",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const created = yield* Effect.tryPromise(() =>
      fetch(`${url}/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: repoName,
          description: "tutorial repo",
        }),
      }).then((r) => r.json()),
    );
    expect(created.name).toBe(repoName);
    expect(created.remote).toBeString();
    expect(created.token).toBeString();

    const starred = yield* Effect.tryPromise(() =>
      fetch(`${url}/repos/${repoName}/star`, { method: "POST" }).then((r) =>
        r.json(),
      ),
    );
    expect(starred.stars).toBe(1);

    yield* Effect.tryPromise(() =>
      fetch(`${url}/repos/${repoName}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "now with stars",
          topics: ["demo", "alchemy"],
        }),
      }),
    );

    const info = yield* Effect.tryPromise(() =>
      fetch(`${url}/repos/${repoName}`).then((r) => r.json()),
    );
    expect(info.name).toBe(repoName);
    expect(info.metadata.description).toBe("now with stars");
    expect(info.metadata.topics).toEqual(["demo", "alchemy"]);
    expect(info.metadata.stars).toBe(1);

    const token = yield* Effect.tryPromise(() =>
      fetch(`${url}/repos/${repoName}/clone-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "read", ttl: 600 }),
      }).then((r) => r.json()),
    );
    expect(token.token).toBeString();

    yield* Effect.tryPromise(() =>
      fetch(`${url}/repos/${repoName}`, { method: "DELETE" }),
    );
  }),
  { timeout: 120_000 },
);
