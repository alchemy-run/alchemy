import { expect } from "bun:test";
import * as Archil from "@alchemy.run/archil";
import * as Test from "@alchemy.run/test/Bun";
import * as Objects from "@distilled.cloud/archil/Objects";
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

test.provider(
  "PUT writes a file to the disk and GET reads it back",
  () =>
    Effect.gen(function* () {
      const { url, diskId } = yield* stack;
      const key = `notes/${crypto.randomUUID()}.txt`;
      const put = yield* send(
        HttpClientRequest.put(`${url}/${key}`).pipe(HttpClientRequest.bodyText("on the disk")),
      );
      expect(put.status).toBe(201);
      const get = yield* send(HttpClientRequest.get(`${url}/${key}`));
      expect(yield* get.text).toBe("on the disk");

      // Out of band: the file is on the disk.
      const text = yield* Objects.getObjectText({ disk: String(diskId) }, key).pipe(
        Effect.provide(Objects.ObjectCredentialsFromApiKey),
      );
      expect(text).toBe("on the disk");
    }),
  { timeout: 180_000 },
);

test(
  "GET of a missing file is a 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* send(HttpClientRequest.get(`${url}/missing.txt`));
    expect(res.status).toBe(404);
  }),
  { timeout: 180_000 },
);

test(
  "the async service answers with its env",
  Effect.gen(function* () {
    const { helloUrl } = yield* stack;
    const res = yield* send(HttpClientRequest.get(`${helloUrl}/there`));
    expect(yield* res.text).toBe("hello from /there");
  }),
  { timeout: 180_000 },
);
