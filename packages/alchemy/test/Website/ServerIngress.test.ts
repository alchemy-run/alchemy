import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { forwarderConfig, getRouted, makeForwarder } from "@alchemy.run/test/IngressForwarder";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as pathe from "pathe";
import type { IngressConfig } from "@/Local/Ingress.ts";
import * as Namespace from "@/Namespace.ts";
import { Server, ServerProvider } from "@/Website/Server.ts";

// In-process (`sidecar: false`): the test provides `Ingress.Adapters` around
// `stack.deploy`, which a sidecar process would never see.
const { test } = Test.make({ providers: ServerProvider(), dev: true, sidecar: false });

const framework = pathe.resolve(import.meta.dirname, "fixtures/ingress-framework.ts");

const RAW_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

/** A `Website.Server`, in a `site` namespace the way a composite declares it. */
const server = (site: string | undefined, ingress: IngressConfig | undefined) => {
  const build = Server("Build", {
    framework,
    target: "unused",
    dev: ingress === undefined ? {} : { ingress },
  });
  return site === undefined ? build : Namespace.push(site, build);
};

const getRaw = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

test.provider(
  "a site's url is its routed origin and localUrl is the framework's listener",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;
        const deploy = (ingress: IngressConfig | undefined) =>
          stack.deploy(server("Web", ingress)).pipe(Effect.provide(forwarder.adapters));

        // ── with ingress
        const routed = yield* deploy(forwarderConfig());
        const [fqn, route] = [...forwarder.routes()][0]!;
        expect(fqn).toBe("Web/Build");
        // The route is named after the site, not the server inside it.
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
  "a server outside a namespace names its route after itself",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const routed = yield* stack
          .deploy(server(undefined, forwarderConfig()))
          .pipe(Effect.provide(forwarder.adapters));

        const [fqn, route] = [...forwarder.routes()][0]!;
        expect(fqn).toBe("Build");
        expect(route.host).toContain(".build.");
        expect(routed.url).toBe(`http://${route.host}:${forwarder.port}`);

        yield* stack.destroy();
        // Deleting the server closes its instance scope, and the route with it.
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  { tags: ["unit", "local"], timeout: 60_000 },
);

test.provider(
  "an ingress adapter that can't be resolved fails the server instead of advertising a URL",
  (stack) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stack.destroy();
        const forwarder = yield* makeForwarder;

        const exit = yield* Effect.exit(
          stack.deploy(server("Web", { type: "nope" })).pipe(Effect.provide(forwarder.adapters)),
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

      const routed = yield* stack.deploy(server("Web", forwarderConfig()));
      const origin = routed.url!;
      expect(origin).toMatch(/^http:\/\/[a-z0-9-]+\.web\.[a-z0-9-]+\.localhost:\d+$/);
      expect(routed.localUrl).toMatch(RAW_URL);
      expect((yield* getRouted(origin, "/page")).body).toBe(`/page ${new URL(origin).host}`);

      // Removing `ingress` restores the listener and drops the sidecar's route.
      const plain = yield* stack.deploy(server("Web", undefined));
      expect(plain.url).toMatch(RAW_URL);
      expect((yield* getRouted(origin)).status).toBe(502);

      yield* stack.destroy();
    }),
  { tags: ["unit", "local"], timeout: 60_000 },
);
