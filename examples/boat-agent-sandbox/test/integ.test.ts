import { expect } from "bun:test";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { executeWhenReady } = Test;
const user = `user-${Test.defaultStage()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

test(
  "runs code in a one-shot sandbox",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* executeWhenReady(
      HttpClientRequest.post(`${url}/run`).pipe(HttpClientRequest.bodyText("console.log(6 * 7)")),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { stdout: string; exitCode: number };
    expect(body).toMatchObject({ stdout: "42\n", exitCode: 0 });
  }),
  { timeout: 180_000 },
);

test(
  "keeps a user's files in their sandbox across requests",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const put = yield* executeWhenReady(
      HttpClientRequest.put(`${url}/users/${user}/files/notes.md`).pipe(
        HttpClientRequest.bodyText("hello"),
      ),
    );
    const first = (yield* put.json) as { sandboxId: string; files: string[]; content: string };
    expect(first.content).toBe("hello");

    const get = yield* HttpClient.execute(
      HttpClientRequest.get(`${url}/users/${user}/files/notes.md`),
    );
    const second = (yield* get.json) as { sandboxId: string; files: string[]; content: string };
    expect(second.sandboxId).toBe(first.sandboxId);
    expect(second.files).toContain("notes.md");

    // The user's sandbox was created at runtime: delete it through the API.
    const removed = yield* HttpClient.execute(HttpClientRequest.delete(`${url}/users/${user}`));
    expect(removed.status).toBe(204);
  }),
  { timeout: 300_000 },
);
