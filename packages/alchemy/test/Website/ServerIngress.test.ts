import { assert, describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getRouted } from "@alchemy.run/test/IngressForwarder";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as pathe from "pathe";
import type * as Ingress from "@/Local/Ingress.ts";
import * as Namespace from "@/Namespace.ts";
import { Server, ServerProvider, withSiteRoute } from "@/Website/Server.ts";

// The default topology of `alchemy dev`: the Server provider runs in a sidecar
// process, which imports the ingress module and keeps its routes. The test sees
// only what a user would: the server's `url` and `localUrl`, and what answers
// there.
const { test } = Test.make({ providers: ServerProvider(), dev: true });

const framework = pathe.resolve(import.meta.dirname, "fixtures/ingress-framework.ts");

/** `@alchemy.run/test`'s forwarder: a real router on a loopback port. */
const forwarder = (name?: string): Ingress.Ingress => ({
  module: "@alchemy.run/test/IngressForwarder",
  name,
});

const RAW_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

/**
 * A site composite's server: `"Build"` in the site's namespace, with the route
 * named after the site, as every composite declares it.
 */
const site = (id: string, ingress: Ingress.Ingress | undefined) =>
  Namespace.push(
    id,
    Server("Build", {
      framework,
      target: "unused",
      dev: withSiteRoute(id, ingress === undefined ? {} : { ingress }),
    }),
  );

/** A `Website.Server` a user declares, optionally inside a namespace. */
const userServer = (id: string, ingress: Ingress.Ingress | undefined, namespace?: string) => {
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

// The forwarder is one Router per sidecar process, keyed by fqn, so each case
// declares its own ids.
describe("Website.Server dev.ingress", { tags: ["unit", "local"] }, () => {
  test.provider(
    "a site composite's route is called the site's id, and localUrl is the framework's listener",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // ── with ingress
        const routed = yield* stack.deploy(site("Web", forwarder()));
        const origin = routed.url!;
        // The route is called the site, not the server inside it.
        expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.web\.[a-z0-9-]+\.localhost:\d+$/);
        expect(routed.localUrl).toMatch(RAW_URL);

        // The routed name reaches the dev server with its Host; the listener
        // answers on its own address too.
        expect((yield* getRouted(origin, "/page")).body).toBe(`/page ${new URL(origin).host}`);
        expect(yield* getRaw(`${routed.localUrl}/page`)).toBe(
          `/page ${new URL(routed.localUrl!).host}`,
        );

        // ── renaming the route moves the origin
        const renamed = yield* stack.deploy(site("Web", forwarder("storefront")));
        expect(renamed.url).toMatch(/\.storefront\./);
        expect((yield* getRouted(renamed.url!)).status).toBe(200);
        expect((yield* getRouted(origin)).status).toBe(502);

        // ── without ingress
        const plain = yield* stack.deploy(site("Web", undefined));
        expect(plain.url).toMatch(RAW_URL);
        expect(plain.localUrl).toBe(plain.url);
        expect((yield* getRouted(renamed.url!)).status).toBe(502);

        yield* stack.destroy();
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "a Server a user declares is called its own id, wherever it sits",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const routed = yield* stack.deploy(userServer("Api", forwarder(), "Backend"));
        const origin = routed.url!;
        expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.api\.[a-z0-9-]+\.localhost:\d+$/);
        expect(origin).not.toContain(".backend.");
        expect((yield* getRouted(origin)).status).toBe(200);

        yield* stack.destroy();
        // Deleting the server closes its instance scope, and the route with it.
        expect((yield* getRouted(origin)).status).toBe(502);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "two Servers in one namespace get distinct routes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const routed = yield* stack.deploy(
          Namespace.push(
            "Team",
            Effect.all({
              orders: userServer("Orders", forwarder()),
              admin: userServer("Admin", forwarder()),
            }),
          ),
        );

        expect(routed.orders.url).toMatch(/\.orders\./);
        expect(routed.admin.url).toMatch(/\.admin\./);
        const orders = yield* getRouted(routed.orders.url!);
        const admin = yield* getRouted(routed.admin.url!);
        expect(orders.body).toBe(`/ ${new URL(routed.orders.url!).host}`);
        expect(admin.body).toBe(`/ ${new URL(routed.admin.url!).host}`);

        yield* stack.destroy();
        expect((yield* getRouted(routed.orders.url!)).status).toBe(502);
        expect((yield* getRouted(routed.admin.url!)).status).toBe(502);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "a name in the ingress wins, on a site and on a Server alike",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const routed = yield* stack.deploy(
          Effect.all({
            site: site("Store", forwarder("shopfront")),
            server: userServer("Billing", forwarder("invoices")),
          }),
        );

        expect(routed.site.url).toMatch(/\.shopfront\./);
        expect(routed.site.url).not.toMatch(/\.store\./);
        expect(routed.server.url).toMatch(/\.invoices\./);
        expect((yield* getRouted(routed.site.url!)).status).toBe(200);
        expect((yield* getRouted(routed.server.url!)).status).toBe(200);

        yield* stack.destroy();
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "an ingress module that can't be loaded fails the server instead of advertising a URL",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const exit = yield* Effect.exit(
          stack.deploy(site("Broken", { module: "@alchemy.run/no-such-router" })),
        );

        assert(Exit.isFailure(exit));
        const message = Cause.pretty(exit.cause);
        expect(message).toContain("Ingress module @alchemy.run/no-such-router");

        yield* stack.destroy();
      }),
    { timeout: 60_000 },
  );
});

describe("withSiteRoute", { tags: ["unit", "local"] }, () => {
  it("calls an unnamed ingress route after the site", () => {
    const dev = { port: 3000, ingress: { module: "router" } };
    expect(withSiteRoute("Web", dev)).toEqual({
      port: 3000,
      ingress: { module: "router", name: "Web" },
    });
    // The user's props are not mutated.
    expect(dev.ingress).toEqual({ module: "router" });
  });

  it("leaves every other dev as it is, so a site without ingress sees no props change", () => {
    const named = { ingress: { module: "router", name: "storefront" } };
    const noIngress = { port: 3000 };
    const external = { mode: "external", url: "http://localhost:1" } as const;
    expect(withSiteRoute("Web", undefined)).toBeUndefined();
    expect(withSiteRoute("Web", named)).toBe(named);
    expect(withSiteRoute("Web", noIngress)).toBe(noIngress);
    expect(withSiteRoute("Web", external)).toBe(external);
  });
});
