import * as DigitalOcean from "@alchemy.run/digitalocean";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow } from "../support.ts";
import BindingsApp, { Files } from "./fixtures/bindings-app.ts";

const { beforeAll, afterAll, deploy, destroy, test } = Test.make({
  providers: DigitalOcean.providers(),
});

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:spaces", "live"];

const Stack = Alchemy.Stack(
  "DigitalOceanSpacesBindings",
  { providers: DigitalOcean.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* BindingsApp;
    const bucket = yield* Files;
    return { url: app.url, bucketName: bucket.bucketName };
  }),
);

const stack = beforeAll(skipSlow ? Effect.succeed({ url: "", bucketName: "" }) : deploy(Stack), {
  timeout: 1_800_000,
  exclusive: "digitalocean:registry",
});
afterAll.skipIf(skipSlow || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 900_000,
  exclusive: "digitalocean:registry",
});

const call = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${url}${path}`);
    if (response.status >= 500) return yield* Effect.fail(new Error(`HTTP ${response.status}`));
    return { status: response.status, text: yield* response.text };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

describe.sequential("Spaces bindings in a DigitalOcean.App", { tags: LIVE_TAGS }, () => {
  describe("PutObject", () => {
    test.skipIf(skipSlow)(
      "writes an object with the app's scoped key",
      Effect.gen(function* () {
        expect((yield* call("/put?key=hello.txt")).text).toEqual("put");
      }).pipe(logLevel),
      { timeout: 300_000 },
    );
  });

  describe("GetObject", () => {
    test.skipIf(skipSlow)(
      "reads the object back",
      Effect.gen(function* () {
        expect((yield* call("/get?key=hello.txt")).text).toEqual("hello spaces");
      }).pipe(logLevel),
      { timeout: 300_000 },
    );
  });

  describe("HeadObject", () => {
    test.skipIf(skipSlow)(
      "reads the object's metadata",
      Effect.gen(function* () {
        expect(JSON.parse((yield* call("/head?key=hello.txt")).text)).toEqual({
          contentType: "text/plain",
        });
      }).pipe(logLevel),
      { timeout: 300_000 },
    );
  });

  describe("ListObjectsV2", () => {
    test.skipIf(skipSlow)(
      "lists the object",
      Effect.gen(function* () {
        expect(JSON.parse((yield* call("/list")).text)).toEqual({ keys: ["hello.txt"] });
      }).pipe(logLevel),
      { timeout: 300_000 },
    );
  });

  describe("DeleteObject", () => {
    test.skipIf(skipSlow)(
      "deletes the object",
      Effect.gen(function* () {
        expect((yield* call("/delete?key=hello.txt")).text).toEqual("deleted");
        expect(JSON.parse((yield* call("/list")).text)).toEqual({ keys: [] });
      }).pipe(logLevel),
      { timeout: 300_000 },
    );
  });

  describe("Cron", () => {
    test.skipIf(skipSlow)(
      "a scheduled job runs the app's image and writes with its bindings",
      Effect.gen(function* () {
        // Jobs fire on the minute; allow a few for the first run to start.
        const fired = yield* call("/get?key=cron.txt").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (response) => response.status === 200,
            times: 24,
          }),
        );
        expect(fired.text).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }).pipe(logLevel),
      { timeout: 600_000 },
    );
  });
});
