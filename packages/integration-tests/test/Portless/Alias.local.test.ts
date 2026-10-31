import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { listener } from "./fixtures/Listener.ts";
import { readRoutes, routeOf } from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

const proxy = TestProxy.make();
const { test, afterAll } = Test.make({
  providers: proxy.providers(),
  dev: true,
  stage: "dev_alice",
});
afterAll(proxy.stop);

test.provider(
  "Alias routes a name to an existing listener and goes away with the resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("emulator");
      const program = (url: string) =>
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "alias-routes" });
          const floci = yield* Portless.Alias("Floci", { proxy, url });
          return { proxy, floci };
        });

      const deployed = yield* stack.deploy(program(existing.url));
      const stateDirectory = yield* proxy.stateDirectory;
      const port = yield* proxy.port;
      expect(deployed.floci.hostname).toBe("dev-alice.floci.alias-routes.localhost");
      expect(deployed.floci.origin).toBe(`https://dev-alice.floci.alias-routes.localhost:${port}`);

      const response = yield* TestProxy.serving(deployed.floci.origin, deployed.proxy);
      expect(JSON.parse(response.body)).toEqual({ listener: "emulator" });

      // The route is the sidecar's, and carries no process of its own.
      const route = yield* routeOf(stateDirectory, deployed.floci.hostname);
      expect(route).toMatchObject({ port: existing.port });
      expect(route!.pid).not.toBe(process.pid);
      expect(route!.childPgid).toBeUndefined();

      // The route is there, so the next plan has nothing to do.
      expect((yield* stack.plan(program(existing.url))).resources.Floci?.action).toBe("noop");

      // A new sidecar has forgotten every alias: with the route gone, the plan shows an update.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const routesFile = path.join(stateDirectory, "routes.json");
      const routes = yield* readRoutes(stateDirectory);
      yield* fs.writeFileString(
        routesFile,
        JSON.stringify(
          routes.filter((candidate) => candidate.hostname !== deployed.floci.hostname),
        ),
      );
      expect((yield* stack.plan(program(existing.url))).resources.Floci?.action).toBe("update");
      yield* stack.deploy(program(existing.url));
      yield* TestProxy.serving(deployed.floci.origin, deployed.proxy);

      // Pointing it at another listener moves the route.
      const other = yield* listener("admin");
      yield* stack.deploy(program(other.url));
      yield* TestProxy.answers(deployed.floci.origin, deployed.proxy, 200);
      expect((yield* routeOf(stateDirectory, deployed.floci.hostname))!.port).toBe(other.port);

      yield* stack.destroy();
      yield* TestProxy.answers(deployed.floci.origin, deployed.proxy, 404);
      expect(yield* routeOf(stateDirectory, deployed.floci.hostname)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Alias takes a name, or an exact hostname",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("status");
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "alias-names" });
          const named = yield* Portless.Alias("Floci", {
            proxy,
            url: existing.url,
            name: "Emulator",
          });
          const exact = yield* Portless.Alias("Status", {
            proxy,
            url: `http://127.0.0.1:${existing.port}`,
            hostname: "alchemy-portless-status.localhost",
          });
          return { proxy, named, exact };
        }),
      );
      const port = yield* proxy.port;
      expect(deployed.named.hostname).toBe("dev-alice.emulator.alias-names.localhost");
      expect(deployed.exact.hostname).toBe("alchemy-portless-status.localhost");
      expect(deployed.exact.origin).toBe(`https://alchemy-portless-status.localhost:${port}`);
      for (const alias of [deployed.named, deployed.exact]) {
        const response = yield* TestProxy.serving(alias.origin, deployed.proxy);
        expect(JSON.parse(response.body)).toEqual({ listener: "status" });
      }
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);
