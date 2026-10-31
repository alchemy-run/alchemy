import { assert, describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { forwarderConfig, getRouted, makeForwarder } from "@alchemy.run/test/IngressForwarder";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as pathe from "pathe";
import type { IngressConfig } from "@/Local/Ingress.ts";
import * as Namespace from "@/Namespace.ts";
import { Server, ServerProvider, withSiteRoute } from "@/Website/Server.ts";

// In-process (`sidecar: false`): the test provides `Ingress.Adapters` around
// `stack.deploy`, which a sidecar process would never see.
const { test } = Test.make({ providers: ServerProvider(), dev: true, sidecar: false });

const framework = pathe.resolve(import.meta.dirname, "fixtures/ingress-framework.ts");

const RAW_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

/**
 * A site composite's server: `"Build"` in the site's namespace, with the route
 * named after the site, as every composite declares it.
 */
const site = (id: string, ingress: IngressConfig | undefined) =>
  Namespace.push(
    id,
    Server("Build", {
      framework,
      target: "unused",
      dev: withSiteRoute(id, ingress === undefined ? {} : { ingress }),
    }),
  );

/** A `Website.Server` a user declares, optionally inside a namespace. */
const userServer = (id: string, ingress: IngressConfig | undefined, namespace?: string) => {
  const server = Server(id, {
    framework,
    target: "unused",
    dev: ingress === undefined ? {} : { ingress },
  });
  return namespace === undefined ? server : Namespace.push(namespace, server);
};

const getRaw = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

test.provider(
  "a site composite's route is called the site's id, and localUrl is the framework's listener",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;
        const deploy = (ingress: IngressConfig | undefined) =>
          stack.deploy(site("Web", ingress)).pipe(Effect.provide(forwarder.adapters));

        // ── with ingress
        const routed = yield* deploy(forwarderConfig());
        const [fqn, route] = [...forwarder.routes()][0]!;
        expect(fqn).toBe("Web/Build");
        // The route is called the site, not the server inside it.
        expect(route.host).toContain(".web.");
        expect(route.host).not.toContain(".build.");
        const origin = routed.url!;
        expect(origin).toBe(`http://${route.host}:${forwarder.port}`);
        expect(routed.localUrl).toMatch(RAW_URL);
        expect(route.listener).toBe(`${routed.localUrl}/`);

        // The routed name reaches the dev server with its Host; the listener
        // answers on its own address too.
        expect((yield* getRouted(origin, "/page")).body).toBe(`/page ${new URL(origin).host}`);
        expect(yield* getRaw(`${routed.localUrl}/page`)).toBe(
          `/page ${new URL(routed.localUrl!).host}`,
        );

        // ── editing ingress moves the origin
        const edited = yield* deploy(forwarderConfig({ domain: "elsewhere" }));
        expect(edited.url).toMatch(/\.elsewhere\.localhost:\d+$/);
        expect((yield* getRouted(edited.url!)).status).toBe(200);
        expect((yield* getRouted(origin)).status).toBe(502);
        expect(forwarder.routes().size).toBe(1);

        // ── without ingress
        const plain = yield* deploy(undefined);
        expect(plain.url).toMatch(RAW_URL);
        expect(plain.localUrl).toBe(plain.url);
        expect(forwarder.routes().size).toBe(0);
        expect((yield* getRouted(edited.url!)).status).toBe(502);

        yield* stack.destroy();
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

test.provider(
  "a Server a user declares is called its own id, wherever it sits",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const routed = yield* stack
          .deploy(userServer("Api", forwarderConfig(), "Backend"))
          .pipe(Effect.provide(forwarder.adapters));

        const [fqn, route] = [...forwarder.routes()][0]!;
        expect(fqn).toBe("Backend/Api");
        expect(route.host).toContain(".api.");
        expect(route.host).not.toContain(".backend.");
        expect(routed.url).toBe(`http://${route.host}:${forwarder.port}`);

        yield* stack.destroy();
        // Deleting the server closes its instance scope, and the route with it.
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

test.provider(
  "two Servers in one namespace get distinct routes",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const routed = yield* stack
          .deploy(
            Namespace.push(
              "Backend",
              Effect.all({
                api: userServer("Api", forwarderConfig()),
                admin: userServer("Admin", forwarderConfig()),
              }),
            ),
          )
          .pipe(Effect.provide(forwarder.adapters));

        const routes = forwarder.routes();
        expect([...routes.keys()].sort()).toEqual(["Backend/Admin", "Backend/Api"]);
        expect(routes.get("Backend/Api")!.host).toContain(".api.");
        expect(routes.get("Backend/Admin")!.host).toContain(".admin.");
        expect(routed.api.url).not.toBe(routed.admin.url);
        expect((yield* getRouted(routed.api.url!)).status).toBe(200);
        expect((yield* getRouted(routed.admin.url!)).status).toBe(200);

        yield* stack.destroy();
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

test.provider(
  "a name in the ingress config wins, on a site and on a Server alike",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const routed = yield* stack
          .deploy(
            Effect.all({
              site: site("Web", { ...forwarderConfig(), name: "storefront" }),
              server: userServer("Api", { ...forwarderConfig(), name: "orders" }),
            }),
          )
          .pipe(Effect.provide(forwarder.adapters));

        const routes = forwarder.routes();
        expect(routes.get("Web/Build")!.host).toContain(".storefront.");
        expect(routes.get("Web/Build")!.host).not.toContain(".web.");
        expect(routes.get("Api")!.host).toContain(".orders.");
        expect(routed.site.url).toMatch(/\.storefront\./);
        expect(routed.server.url).toMatch(/\.orders\./);

        yield* stack.destroy();
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

describe("withSiteRoute", { tags: ["unit", "local"] }, () => {
  it("calls an unnamed ingress route after the site", () => {
    const dev = { port: 3000, ingress: { type: "forwarder" } };
    expect(withSiteRoute("Web", dev)).toEqual({
      port: 3000,
      ingress: { type: "forwarder", name: "Web" },
    });
    // The user's props are not mutated.
    expect(dev.ingress).toEqual({ type: "forwarder" });
  });

  it("leaves every other dev as it is, so a site without ingress sees no props change", () => {
    const named = { ingress: { type: "forwarder", name: "storefront" } };
    const noIngress = { port: 3000 };
    const external = { mode: "external", url: "http://localhost:1" } as const;
    expect(withSiteRoute("Web", undefined)).toBeUndefined();
    expect(withSiteRoute("Web", named)).toBe(named);
    expect(withSiteRoute("Web", noIngress)).toBe(noIngress);
    expect(withSiteRoute("Web", external)).toBe(external);
  });
});

test.provider(
  "an ingress adapter that can't be resolved fails the server instead of advertising a URL",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const exit = yield* Effect.exit(
          stack.deploy(site("Web", { type: "nope" })).pipe(Effect.provide(forwarder.adapters)),
        );

        assert(Exit.isFailure(exit));
        const message = Cause.pretty(exit.cause);
        expect(message).toContain('"nope"');
        expect(message).toContain("@alchemy.run/nope");
        expect(forwarder.routes().size).toBe(0);

        yield* stack.destroy();
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

// The default topology of `alchemy dev`: the Server provider runs in a sidecar
// process, which resolves the adapter from the package that contributes it
// (`@alchemy.run/test` contributes the forwarder, see `IngressContributions.ts`)
// and keeps the routes in its own process. The test sees only what a user would:
// the site's `url` and `localUrl`, and what answers there.
const { test: sidecarTest } = Test.make({ providers: ServerProvider(), dev: true });

sidecarTest.provider(
  "a site routes through an adapter the sidecar resolves from a contributing package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const routed = yield* stack.deploy(site("Web", forwarderConfig()));
      const origin = routed.url!;
      expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.web\.[a-z0-9-]+\.localhost:\d+$/);
      expect(routed.localUrl).toMatch(RAW_URL);
      expect((yield* getRouted(origin, "/page")).body).toBe(`/page ${new URL(origin).host}`);

      // Removing `ingress` restores the listener and drops the sidecar's route.
      const plain = yield* stack.deploy(site("Web", undefined));
      expect(plain.url).toMatch(RAW_URL);
      expect((yield* getRouted(origin)).status).toBe(502);

      yield* stack.destroy();
    }),
  { tags: ["unit", "local"], timeout: 60_000 },
);
