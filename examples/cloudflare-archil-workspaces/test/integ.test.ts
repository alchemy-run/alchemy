import { expect } from "bun:test";
import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "a user's notes live on their own disk and a sandbox can read them",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const ready = yield* Test.getWhenReady(`${base}/alice/notes`);
    expect(ready.status).toBe(200);

    const post = (text: string) =>
      HttpClient.execute(
        HttpClientRequest.post(`${base}/alice/notes`).pipe(HttpClientRequest.bodyText(text)),
      );
    expect((yield* post("first")).status).toBe(200);
    expect((yield* post("second")).status).toBe(200);

    const notes = yield* HttpClient.get(`${base}/alice/notes`).pipe(Effect.flatMap((r) => r.text));
    expect(notes).toBe("- first\n- second\n");

    const session = yield* HttpClient.get(`${base}/alice/session`).pipe(
      Effect.flatMap((r) => r.json),
    );
    expect((session as { fromCheckpoint: string }).fromCheckpoint).toBe("seeded");

    const count = yield* HttpClient.get(`${base}/alice/run`).pipe(Effect.flatMap((r) => r.text));
    expect(count.trim().startsWith("2")).toBe(true);

    // The home disk outlives the stack, so the test removes the user.
    const removed = yield* HttpClient.execute(HttpClientRequest.delete(`${base}/alice`));
    expect(removed.status).toBe(200);
  }),
  { timeout: 300_000 },
);
