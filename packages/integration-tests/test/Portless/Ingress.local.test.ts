import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Ingress from "alchemy/Local/Ingress";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { listener } from "./fixtures/Listener.ts";
import { routeOf } from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// The adapter, through the same calls a resource's local provider makes: `Ingress.origin` and
// `Ingress.route` resolve it from the package's contributions. The consumers (a Worker, a
// `Website.Server`) call exactly these.
const proxy = TestProxy.make();
const { test, afterAll } = Test.make({
  providers: proxy.providers(),
  dev: true,
  stage: "dev_alice",
  sidecar: false,
});
afterAll(proxy.stop);

const program = Effect.gen(function* () {
  return yield* Portless.Proxy("Proxy", { domain: "ingress-adapter" });
});

/** The target a resource's provider derives for a resource of this id. */
const targetOf = (config: Ingress.IngressConfig, id: string) =>
  Ingress.createTarget({
    stack: { name: "ingress-test", stage: "dev_alice" },
    id,
    fqn: id,
    type: "Test.Web",
    config,
  });

/** Routes a target to a listener in a scope the test closes itself. */
const attach = (config: Ingress.IngressConfig, id: string, url: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const close = Scope.close(scope, Exit.void);
    // A failed assertion must not leave a claim behind for the next test.
    yield* Effect.addFinalizer(() => close);
    const origin = yield* Ingress.route(config, targetOf(config, id), new URL(url)).pipe(
      Scope.provide(scope),
    );
    return { origin, close };
  });

test.provider(
  "Ingress names a resource like Origin does, and routes it to its listener until the scope closes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The config is made from the Proxy resource, and its Outputs resolve to the proxy's settings.
      const { proxy: deployed, ingress: config } = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "ingress-adapter" });
          return { proxy, ingress: Portless.Ingress(proxy) };
        }),
      );
      expect(config).toEqual({
        type: "portless",
        options: {
          domain: "ingress-adapter",
          port: deployed.port,
          stateDirectory: deployed.stateDirectory,
        },
      });

      // The name is known before the listener exists, and is the one Origin gives the same id.
      const expected = yield* Portless.Origin("Web", { proxy: deployed }).pipe(
        Effect.provideService(Stage, "dev_alice"),
      );
      expect(expected).toBe(`https://dev-alice.web.ingress-adapter.localhost:${deployed.port}`);
      expect(yield* Ingress.origin(config, targetOf(config, "Web"))).toBe(expected);

      const web = yield* listener("web");
      const attached = yield* attach(config, "Web", web.url);
      expect(attached.origin).toBe(expected);

      const response = yield* TestProxy.serving(expected, deployed);
      expect(JSON.parse(response.body)).toEqual({ listener: "web" });
      const hostname = new URL(expected).hostname;
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toMatchObject({
        port: web.port,
        pid: process.pid,
      });

      // Closing the scope removes the route, and the proxy stops serving the name.
      yield* attached.close;
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toBeUndefined();
      yield* TestProxy.answers(expected, deployed, 404);
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Ingress follows the attach rules: the same listener changes nothing, a new one replaces, the latest owns the route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(program);
      const config = Portless.Ingress(deployed);
      const other = yield* attach(config, "Other", (yield* listener("other")).url);
      const first = yield* listener("first");
      const second = yield* listener("second");
      const hostname = `dev-alice.web.ingress-adapter.localhost`;
      const answers = (origin: string) =>
        TestProxy.serving(origin, deployed).pipe(Effect.map((r) => JSON.parse(r.body).listener));

      // The same resource and listener again changes nothing.
      const a = yield* attach(config, "Web", first.url);
      const before = yield* routeOf(deployed.stateDirectory, hostname);
      const b = yield* attach(config, "Web", first.url);
      expect(b.origin).toBe(a.origin);
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toEqual(before);

      // A new listener replaces the route.
      const c = yield* attach(config, "Web", second.url);
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toMatchObject({
        port: second.port,
      });
      expect(yield* answers(a.origin)).toBe("second");

      // Closing an earlier attach removes nothing: a later one took the route over.
      yield* a.close;
      yield* b.close;
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toMatchObject({
        port: second.port,
      });
      expect(yield* answers(a.origin)).toBe("second");

      // Closing the latest removes its route and nothing else.
      yield* c.close;
      expect(yield* routeOf(deployed.stateDirectory, hostname)).toBeUndefined();
      expect(
        yield* routeOf(deployed.stateDirectory, "dev-alice.other.ingress-adapter.localhost"),
      ).toBeDefined();
      yield* other.close;
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Ingress takes its name from IngressConfig.name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(program);
      const config = Portless.Ingress(deployed, { name: "Site" });
      expect(config.name).toBe("Site");
      expect(yield* Ingress.origin(config, targetOf(config, "Website"))).toBe(
        `https://dev-alice.site.ingress-adapter.localhost:${deployed.port}`,
      );
    }),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Ingress refuses what it can't route, naming why, and routes nothing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "ingress-adapter" });
          // The name another resource of this process already routes.
          const taken = yield* Portless.Dev("Web", {
            proxy,
            command:
              'node -e \'require("http").createServer((_, r) => r.end("ok")).listen(process.env.PORT, "127.0.0.1")\'',
          });
          return { proxy, taken };
        }),
      );
      const config = Portless.Ingress(deployed.proxy);
      const failure = (id: string, url: string) =>
        Effect.flip(Ingress.route(config, targetOf(config, id), new URL(url)).pipe(Effect.scoped));

      const claimed = yield* failure("Web", "http://localhost:4000");
      expect(claimed).toBeInstanceOf(Ingress.IngressError);
      expect(claimed.message).toContain("already routed");

      // Portless forwards plain HTTP to a port on this machine.
      const secure = yield* failure("Secure", "https://localhost:4000");
      expect(secure).toBeInstanceOf(Ingress.IngressError);
      expect(secure.message).toContain("plain HTTP");
      const remote = yield* failure("Remote", "http://example.com:4000");
      expect(remote.message).toContain("loopback");

      expect(
        yield* routeOf(deployed.proxy.stateDirectory, "dev-alice.secure.ingress-adapter.localhost"),
      ).toBeUndefined();
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

// With PORTLESS=0 there is no proxy to name anything.
const off = TestProxy.make({ PORTLESS: "0" });
afterAll(off.stop);

test.provider(
  "Ingress with PORTLESS=0 routes nothing and answers with the listener's own address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const config = Portless.Ingress({
        domain: "ingress-adapter",
        port: 443,
        stateDirectory: yield* off.stateDirectory,
      });
      const web = yield* listener("web");
      const origin = yield* Ingress.route(config, targetOf(config, "Web"), new URL(web.url)).pipe(
        Effect.scoped,
        Effect.provide(off.config),
      );
      expect(origin).toBe(`${web.url}/`);

      // The origin is known only once there is a listener.
      const unknown = yield* Effect.flip(
        Ingress.origin(config, targetOf(config, "Web")).pipe(Effect.provide(off.config)),
      );
      expect(unknown).toBeInstanceOf(Ingress.IngressError);
      expect(unknown.message).toContain("PORTLESS=0");
    }),
  { tags: ["local"], timeout: 120_000 },
);
