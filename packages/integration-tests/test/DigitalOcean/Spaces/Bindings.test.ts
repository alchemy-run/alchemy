import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow } from "../support.ts";
import BindingsApp, { Files } from "./fixtures/bindings-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:spaces", "live"];

const call = (url: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${url}${path}`);
    if (response.status >= 500) return yield* Effect.fail(new Error(`HTTP ${response.status}`));
    return { status: response.status, text: yield* response.text };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

// A team holds one registry, so the app deploys, runs every binding and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "Spaces bindings and a cron job in a DigitalOcean.App",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* BindingsApp;
          yield* Files;
          return { url: app.url };
        }),
      );

      // PutObject writes with the app's scoped key.
      expect((yield* call(url, "/put?key=hello.txt")).text).toEqual("put");
      // GetObject reads it back.
      expect((yield* call(url, "/get?key=hello.txt")).text).toEqual("hello spaces");
      // HeadObject reads its metadata.
      expect(JSON.parse((yield* call(url, "/head?key=hello.txt")).text)).toEqual({
        contentType: "text/plain",
      });
      // ListObjectsV2 lists it.
      expect(JSON.parse((yield* call(url, "/list")).text)).toEqual({ keys: ["hello.txt"] });
      // DeleteObject removes it.
      expect((yield* call(url, "/delete?key=hello.txt")).text).toEqual("deleted");
      expect(JSON.parse((yield* call(url, "/list")).text)).toEqual({ keys: [] });

      // Cron: the scheduled job runs the app's image and writes with its
      // bindings. It fires on the quarter hour, so the first run can be 15
      // minutes out.
      const fired = yield* call(url, "/get?key=cron.txt").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (response) => response.status === 200,
          times: 54,
        }),
      );
      expect(fired.text).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 3_600_000, exclusive: "digitalocean:registry" },
);
