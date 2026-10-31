import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Stage } from "alchemy/Stage";
import { findAvailablePort } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";
import { listener } from "./fixtures/Listener.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// PORTLESS=0 is read wherever a provider runs, so these run in the test process, where the
// override is. The state directory and port are the test's own: a proxy started by mistake
// would show up in them.
const disabled = TestProxy.make({ PORTLESS: "0" });
const { test, afterAll } = Test.make({
  providers: disabled.providers(),
  dev: true,
  sidecar: false,
  stage: "dev_alice",
});
afterAll(disabled.stop);

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");

test.provider(
  "with PORTLESS=0 there is no proxy: Dev serves http://localhost:<port>, Alias returns its url",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("emulator");
      const webPort = yield* findAvailablePort();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "disabled" });
          const webOrigin = yield* Portless.Origin("Web", { proxy, port: webPort });
          const api = yield* Portless.Dev("Api", {
            proxy,
            command: `node ${server}`,
            env: { SERVER_NAME: "api", WEB_ORIGIN: webOrigin },
          });
          const web = yield* Portless.Dev("Web", {
            proxy,
            port: webPort,
            command: `node ${server}`,
            env: { SERVER_NAME: "web" },
          });
          const floci = yield* Portless.Alias("Floci", { proxy, url: existing.url });
          return { proxy, webOrigin, api, web, floci };
        }).pipe(Effect.provide(disabled.config)),
      );

      expect(deployed.webOrigin).toBe(`http://localhost:${webPort}`);
      expect(deployed.web.origin).toBe(`http://localhost:${webPort}`);
      expect(deployed.web.port).toBe(webPort);
      expect(deployed.api.origin).toBe(`http://localhost:${deployed.api.port}`);
      expect(deployed.floci.origin).toBe(existing.url);

      const api = yield* Effect.promise(
        () =>
          fetch(`http://127.0.0.1:${deployed.api.port}`).then((response) =>
            response.json(),
          ) as Promise<Record<string, unknown>>,
      );
      expect(api).toMatchObject({
        name: "api",
        port: deployed.api.port,
        host: "127.0.0.1",
        portlessUrl: deployed.api.origin,
      });
      // There is no proxy, so nothing to trust and no state directory to point at.
      expect(api.extraCaCerts).toBeUndefined();
      expect(api.stateDirectory).toBeUndefined();

      // Nothing started a proxy or wrote a route.
      const fs = yield* FileSystem.FileSystem;
      const stateDirectory = yield* disabled.stateDirectory;
      expect(yield* fs.readDirectory(stateDirectory)).toEqual([]);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test(
  "with PORTLESS=0 Origin is http://localhost:<port>, and needs the port",
  Effect.gen(function* () {
    const origin = yield* Portless.Origin("Web", { proxy: { domain: "disabled" }, port: 5173 });
    expect(origin).toBe("http://localhost:5173");
    const error = yield* Effect.flip(Portless.Origin("Web", { proxy: { domain: "disabled" } }));
    expect(error._tag).toBe("OriginPortRequired");
  }).pipe(Effect.provideService(Stage, "dev_alice"), Effect.provide(disabled.config)),
);
