import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";
import { listener } from "./fixtures/Listener.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// Not `dev: true`: this is what `alchemy deploy` runs. The state directory and port are the
// test's own, so a proxy started by mistake would show up in them.
const proxy = TestProxy.make();
const { test, afterAll } = Test.make({ providers: proxy.providers(), stage: "dev_alice" });
afterAll(proxy.stop);

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");

test.provider(
  "a plain deploy starts no proxy and no command, and names nothing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("emulator");
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "deploy" });
          const webOrigin = yield* Portless.Origin("Web", { proxy });
          const api = yield* Portless.Dev("Api", { proxy, command: `node ${server}` });
          const floci = yield* Portless.Alias("Floci", { proxy, url: existing.url });
          return { proxy, webOrigin, api, floci };
        }),
      );

      // Placeholders: there is no proxy to name anything.
      expect(deployed.proxy).toMatchObject({ domain: "deploy", stateDirectory: "" });
      expect(deployed.api).toEqual({ hostname: "", origin: "", port: 0 });
      expect(deployed.floci).toEqual({ hostname: "", origin: "" });

      // Nothing started a proxy or wrote a route.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(yield* proxy.stateDirectory)).toEqual([]);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);
