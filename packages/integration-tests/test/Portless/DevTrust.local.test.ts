import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import * as TestProxy from "./fixtures/TestProxy.ts";

// The Portless CA reaches the commands Dev starts through `alchemy dev`'s trust: the package
// contributes its path, the session hands it to the sidecar, and `spawn` writes the bundle. This
// file publishes its proxy's CA and has a sidecar of its own: the shared one keeps the
// environment of whichever file started it first, and would trust that file's CA instead.
const proxy = TestProxy.make({}, { trust: true });
const { test, afterAll } = Test.make({
  providers: proxy.providers(),
  dev: true,
  stage: "dev_alice",
  sidecar: { omitEnv: ["PORTLESS_TEST_NO_SUCH_VARIABLE_"] },
});
afterAll(proxy.stop);

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");

test.provider(
  "a Dev command trusts the Portless CA, and calls another Dev over verified HTTPS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-trust" });
          const api = yield* Portless.Dev("Api", {
            proxy,
            command: `node ${server}`,
            env: { SERVER_NAME: "api" },
          });
          const web = yield* Portless.Dev("Web", {
            proxy,
            command: `node ${server}`,
            env: { SERVER_NAME: "web", API_URL: api.origin },
          });
          return { proxy, api, web };
        }),
      );

      // The child was told about the CA, and nothing in its environment names it directly.
      const root = yield* TestProxy.serving(deployed.web.origin, deployed.proxy);
      const environment = JSON.parse(root.body);
      expect(environment.devTrust.split(":")).toContain(deployed.proxy.certificateAuthority);
      expect(environment.extraCaCerts).not.toBe(deployed.proxy.certificateAuthority);

      // Web reaches Api through the proxy, verifying the certificate with that bundle alone.
      const called = yield* TestProxy.serving(deployed.web.origin, deployed.proxy, "/call");
      const result = JSON.parse(called.body);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ name: "api", port: deployed.api.port });

      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000, exclusive: true },
);
