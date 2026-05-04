import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
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

    const created = yield* HttpClient.post(`${url}/repos`, {
      body: yield* HttpBody.json({
        name: repoName,
        description: "tutorial repo",
      }),
    }).pipe(Effect.flatMap((res) => res.json));
    expect((created as any).name).toBe(repoName);
    expect((created as any).remote).toBeString();
    expect((created as any).token).toBeString();

    const starred = yield* HttpClient.post(
      `${url}/repos/${repoName}/star`,
    ).pipe(Effect.flatMap((res) => res.json));
    expect((starred as any).stars).toBe(1);

    yield* HttpClient.patch(`${url}/repos/${repoName}`, {
      body: yield* HttpBody.json({
        description: "now with stars",
        topics: ["demo", "alchemy"],
      }),
    });

    const info = yield* HttpClient.get(`${url}/repos/${repoName}`).pipe(
      Effect.flatMap((res) => res.json),
    );
    expect((info as any).name).toBe(repoName);
    expect((info as any).metadata.description).toBe("now with stars");
    expect((info as any).metadata.topics).toEqual(["demo", "alchemy"]);
    expect((info as any).metadata.stars).toBe(1);

    const token = yield* HttpClient.post(
      `${url}/repos/${repoName}/clone-token`,
      {
        body: yield* HttpBody.json({ scope: "read", ttl: 600 }),
      },
    ).pipe(Effect.flatMap((res) => res.json));
    expect((token as any).plaintext).toBeString();
    expect((token as any).scope).toBe("read");

    yield* HttpClient.del(`${url}/repos/${repoName}`);
  }),
  { timeout: 120_000 },
);
