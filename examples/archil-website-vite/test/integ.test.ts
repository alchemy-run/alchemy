import { expect } from "bun:test";
import * as Archil from "@alchemy.run/archil";
import * as Test from "@alchemy.run/test/Bun";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Archil.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const executeOk = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status === 200 || res.status === 201
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 30,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "SPA renders the Notes heading",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (!url) throw new Error("expected the site to expose a url");
    const base = String(url).replace(/\/+$/, "");
    const response = yield* executeOk(HttpClientRequest.get(`${base}/`));
    const body = yield* response.text;
    expect(body).toContain("Notes — Archil");
  }),
  { timeout: 180_000 },
);

test.provider(
  "API persists a note as a file on the disk",
  () =>
    Effect.gen(function* () {
      const { apiUrl } = yield* stack;
      if (!apiUrl) throw new Error("expected the API url");
      const base = String(apiUrl).replace(/\/+$/, "");
      const marker = `archil-note-${crypto.randomUUID()}`;
      yield* executeOk(
        HttpClientRequest.post(`${base}/notes`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body: marker }),
        ),
      );
      const listed = yield* executeOk(HttpClientRequest.get(`${base}/notes`));
      const payload = (yield* listed.json) as {
        notes: Array<{ body: string }>;
      };
      expect(payload.notes.some((note) => note.body === marker)).toBe(true);

      // Out of band: the note is a JSON file under notes/ on the disk.
      const { diskId } = yield* stack;
      const bodies = yield* Objects.listObjects({ disk: String(diskId) }, "notes/").pipe(
        Stream.mapEffect((o) => Objects.getObjectText({ disk: String(diskId) }, o.key)),
        Stream.runCollect,
        Effect.provide(Objects.ObjectCredentialsFromApiKey),
      );
      expect(bodies.some((text) => text.includes(marker))).toBe(true);
    }),
  { timeout: 180_000 },
);
