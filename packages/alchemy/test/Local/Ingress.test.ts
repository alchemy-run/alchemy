import { assert, describe, expect, it } from "@alchemy.run/test";
import { getRouted, makeListener } from "@alchemy.run/test/IngressForwarder";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Ingress from "@/Local/Ingress.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { builds } from "./fixtures/ingress-forwarder.ts";

/** The fixture module, by the URL `attach` imports it from. */
const forwarder: Ingress.Ingress = {
  module: new URL("./fixtures/ingress-forwarder.ts", import.meta.url).href,
};

const target: Ingress.Target = {
  stack: "myapp",
  stage: "dev_alice",
  fqn: "Backend/Api",
  id: "Api",
  type: "Cloudflare.Worker",
};

/** The services the dev sidecar provides a router's Layer. */
const services = Layer.merge(PlatformServices, FetchHttpClient.layer);

describe("Ingress.attach", { tags: ["unit", "local"] }, () => {
  it.live("routes the origin to the listener", () =>
    Effect.gen(function* () {
      const listener = yield* makeListener("api");
      const origin = yield* Ingress.attach(forwarder, target, listener);
      expect(origin).toMatch(/^http:\/\/dev-alice\.api\.myapp\.localhost:\d+$/);
      const answer = yield* getRouted(origin, "/hello");
      expect(answer.status).toBe(200);
      // The listener sees the routed host, as a browser's request would carry it.
      expect(answer.body).toBe(`api /hello ${new URL(origin).host}`);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("names the route after the ingress's name", () =>
    Effect.gen(function* () {
      const listener = yield* makeListener("web");
      const origin = yield* Ingress.attach({ ...forwarder, name: "Shop" }, target, listener);
      expect(origin).toMatch(/^http:\/\/dev-alice\.shop\.myapp\.localhost:\d+$/);
      expect((yield* getRouted(origin)).body).toMatch(/^web /);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("closing the scope removes the route", () =>
    Effect.gen(function* () {
      const listener = yield* makeListener("api");
      const scope = yield* Scope.make();
      const origin = yield* Ingress.attach(forwarder, { ...target, fqn: "Closed" }, listener).pipe(
        Scope.provide(scope),
      );
      expect((yield* getRouted(origin)).status).toBe(200);

      yield* Scope.close(scope, Exit.void);
      expect((yield* getRouted(origin)).status).toBe(502);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("two stacks' routes for the same fqn are independent", () =>
    Effect.gen(function* () {
      const shop = { ...target, stack: "shop", fqn: "Shared" };
      const blog = { ...target, stack: "blog", fqn: "Shared" };
      const shopScope = yield* Scope.make();
      const shopOrigin = yield* Ingress.attach(forwarder, shop, yield* makeListener("shop")).pipe(
        Scope.provide(shopScope),
      );
      const blogOrigin = yield* Ingress.attach(forwarder, blog, yield* makeListener("blog"));
      expect((yield* getRouted(shopOrigin)).body).toMatch(/^shop /);
      expect((yield* getRouted(blogOrigin)).body).toMatch(/^blog /);

      // Removing one stack's route leaves the other's.
      yield* Scope.close(shopScope, Exit.void);
      expect((yield* getRouted(shopOrigin)).status).toBe(502);
      expect((yield* getRouted(blogOrigin)).body).toMatch(/^blog /);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("builds each module's Layer once per process", () =>
    Effect.gen(function* () {
      const listener = yield* makeListener("api");
      const [one, two] = yield* Effect.all(
        [
          Ingress.attach(forwarder, { ...target, fqn: "One", id: "One" }, listener),
          Ingress.attach(forwarder, { ...target, fqn: "Two", id: "Two" }, listener),
        ],
        { concurrency: "unbounded" },
      );
      // Both routes are on the one forwarder the module built.
      expect(new URL(one).port).toBe(new URL(two).port);
      expect(builds.count).toBe(1);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("a route the router refuses fails with IngressError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Ingress.attach(forwarder, target, new URL("https://localhost:1337")),
      );
      assert(error._tag === "IngressError");
      expect(error.message).toContain("only routes http listeners");
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("a module the project doesn't install fails with IngressError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Ingress.attach(
          { module: "@alchemy.run/no-such-router" },
          target,
          new URL("http://localhost:1"),
        ),
      );
      assert(error._tag === "IngressError");
      expect(error.message).toBe(
        `Ingress module @alchemy.run/no-such-router is not installed in ${process.cwd()}`,
      );
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("a module without a default-export Layer fails with IngressError", () =>
    Effect.gen(function* () {
      const module = new URL("./fixtures/ingress-no-default.ts", import.meta.url).href;
      const error = yield* Effect.flip(
        Ingress.attach({ module }, target, new URL("http://localhost:1")),
      );
      assert(error._tag === "IngressError");
      expect(error.message).toBe(`Ingress module ${module} has no default-export Layer`);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live(
    "resolves the module from the project, not from alchemy's install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A project whose only dependency is a router package alchemy can't see.
        const project = path.resolve(import.meta.dirname, "../../.tmp/ingress-project");
        const router = path.join(project, "node_modules", "acme-router");
        yield* fs.remove(project, { recursive: true }).pipe(Effect.ignore);
        yield* fs.makeDirectory(path.join(router, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(router, "package.json"),
          JSON.stringify({
            name: "acme-router",
            type: "module",
            exports: { "./IngressLive": { import: "./src/IngressLive.ts" } },
          }),
        );
        yield* fs.writeFileString(
          path.join(router, "src", "IngressLive.ts"),
          'export { default } from "@alchemy.run/test/IngressForwarder";\n',
        );
        yield* Effect.addFinalizer(() =>
          fs.remove(project, { recursive: true }).pipe(Effect.ignore),
        );

        const ingress = { module: "acme-router/IngressLive" };
        // From alchemy's own directory the package isn't installed.
        const outside = yield* Effect.flip(
          Ingress.attach(ingress, target, new URL("http://localhost:1")),
        );
        expect(outside.message).toContain("acme-router/IngressLive is not installed in");

        const listener = yield* makeListener("acme");
        const origin = yield* inDirectory(project, Ingress.attach(ingress, target, listener));
        expect((yield* getRouted(origin)).body).toMatch(/^acme /);
      }).pipe(Effect.provide(services), Effect.scoped),
    // Exclusive: changes the process's working directory.
    { exclusive: true },
  );
});

/** Run `effect` with the process's working directory set to `directory`. */
const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd();
      process.chdir(directory);
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );
