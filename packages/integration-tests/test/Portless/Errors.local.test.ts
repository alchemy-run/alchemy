import * as NodeNet from "node:net";
import * as Portless from "@alchemy.run/portless";
import { addRoute } from "@alchemy.run/portless/internal/Routes";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { findAvailablePort } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { listener } from "./fixtures/Listener.ts";
import { readRoutes, routeOf } from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// Typed errors are an in-process contract: across the RPC boundary a failed
// lifecycle op is re-thrown as a flattened defect (see Command/Dev.test.ts), so
// these run the providers in the test process.
const proxy = TestProxy.make();
const { test, afterAll } = Test.make({
  providers: proxy.providers(),
  dev: true,
  sidecar: false,
  stage: "dev_alice",
});
afterAll(proxy.stop);

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : String(error);

test.provider(
  "Alias rejects a url that is not loopback http",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const alias = (url: string) =>
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "alias-urls" });
          return yield* Portless.Alias("Remote", { proxy, url });
        });
      for (const url of [
        "http://example.com:4566",
        "http://192.168.1.10:4566",
        "http://0.0.0.0:4566",
        "https://localhost:4566",
        "not a url",
      ]) {
        const error = yield* Effect.flip(stack.deploy(alias(url)));
        expect(tagOf(error)).toBe("AliasUrlInvalid");
        expect(error).toMatchObject({ url });
      }
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "two resources claiming one hostname fail the second",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("duplicate");
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const proxy = yield* Portless.Proxy("Proxy", { domain: "alias-duplicate" });
            yield* Portless.Alias("First", {
              proxy,
              url: existing.url,
              hostname: "alchemy-portless-dup.localhost",
            });
            yield* Portless.Alias("Second", {
              proxy,
              url: existing.url,
              hostname: "alchemy-portless-dup.localhost",
            });
          }),
        ),
      );
      expect(tagOf(error)).toBe("HostnameClaimed");
      expect(error).toMatchObject({ hostname: "alchemy-portless-dup.localhost" });
      // The route is still the one that got there first.
      const stateDirectory = yield* proxy.stateDirectory;
      expect(
        (yield* readRoutes(stateDirectory)).filter(
          (route) => route.hostname === "alchemy-portless-dup.localhost",
        ),
      ).toHaveLength(1);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "a hostname routed by another live process is rejected, not taken over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const existing = yield* listener("taken");
      // Another process (a shell's `sleep`) holds the route, as another dev session would.
      const holder = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
      yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill()));
      const stateDirectory = yield* proxy.stateDirectory;
      const hostname = "alchemy-portless-taken.localhost";
      yield* addRoute({ stateDirectory, hostname, port: existing.port, ownerPid: holder.pid });

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const proxy = yield* Portless.Proxy("Proxy", { domain: "alias-taken" });
            return yield* Portless.Alias("Taken", { proxy, url: existing.url, hostname });
          }),
        ),
      );
      expect(tagOf(error)).toBe("HostnameClaimed");
      expect(error).toMatchObject({ hostname, pid: holder.pid });
      expect((yield* routeOf(stateDirectory, hostname))!.pid).toBe(holder.pid);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Dev fails rather than shift a port that is taken, and leaves no route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const port = yield* findAvailablePort();
      const occupant = NodeNet.createServer().listen(port, "127.0.0.1");
      yield* Effect.addFinalizer(() => Effect.sync(() => occupant.close()));
      const stateDirectory = yield* proxy.stateDirectory;
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-busy" });
            return yield* Portless.Dev("Api", { proxy, port, command: `node ${server}` });
          }),
        ),
      );
      expect(tagOf(error)).toBe("DevPortInUse");
      expect(error).toMatchObject({ port });
      expect((yield* readRoutes(stateDirectory)).map((route) => route.hostname)).not.toContain(
        "dev-alice.api.dev-busy.localhost",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "a Dev command that exits before listening fails and leaves no route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stateDirectory = yield* proxy.stateDirectory;
      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-exits" });
            return yield* Portless.Dev("Api", {
              proxy,
              command: "echo boom >&2; exit 3",
            });
          }),
        ),
      );
      expect(tagOf(error)).toBe("CommandError");
      expect(JSON.stringify(error)).toContain("boom");
      expect((yield* readRoutes(stateDirectory)).map((route) => route.hostname)).not.toContain(
        "dev-alice.api.dev-exits.localhost",
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);
