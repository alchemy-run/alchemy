import { assert, describe, expect, it } from "@alchemy.run/test";
import {
  FORWARDER_TYPE,
  getRouted,
  makeForwarder,
  makeListener,
} from "@alchemy.run/test/IngressForwarder";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Ingress from "@/Local/Ingress.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const config: Ingress.IngressConfig = { type: FORWARDER_TYPE };

const target: Ingress.IngressTarget = {
  stack: "myapp",
  stage: "dev_alice",
  fqn: "Backend/Api",
  id: "Api",
  label: "api",
  type: "Cloudflare.Worker",
};

/** A forwarder registered as `Ingress.Adapters`, under the services adapters run under. */
const withForwarder = <A, E>(
  use: (
    forwarder: Effect.Success<typeof makeForwarder>,
  ) => Effect.Effect<A, E, Scope.Scope | Ingress.IngressServices>,
) =>
  Effect.gen(function* () {
    const forwarder = yield* makeForwarder;
    return yield* use(forwarder).pipe(Effect.provide(forwarder.adapters));
  }).pipe(Effect.provide(Layer.merge(PlatformServices, FetchHttpClient.layer)), Effect.scoped);

describe("Ingress", { tags: ["unit", "local"] }, () => {
  it.live("origin answers before any listener exists", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const origin = yield* Ingress.origin(config, target);
        expect(origin).toBe(`http://dev-alice.api.myapp.localhost:${forwarder.port}`);
        expect(forwarder.routes().size).toBe(0);

        // The listener shows up later; the origin does not move.
        const listener = yield* makeListener("api");
        const routed = yield* Ingress.route(config, target, listener);
        expect(routed).toBe(origin);
        expect(yield* Ingress.origin(config, target)).toBe(origin);
      }),
    ),
  );

  it.live("route forwards the origin to the listener", () =>
    withForwarder(() =>
      Effect.gen(function* () {
        const listener = yield* makeListener("api");
        const origin = yield* Ingress.route(config, target, listener);
        const answer = yield* getRouted(origin, "/hello");
        expect(answer.status).toBe(200);
        // The listener sees the routed host, as a browser's request would carry it.
        expect(answer.body).toBe(`api /hello ${new URL(origin).host}`);
      }),
    ),
  );

  it.live("closing the scope removes the route", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const listener = yield* makeListener("api");
        const scope = yield* Scope.make();
        const origin = yield* Ingress.route(config, target, listener).pipe(Scope.provide(scope));
        expect(forwarder.routes().get(target.fqn)?.listener).toBe(listener.href);
        expect((yield* getRouted(origin)).status).toBe(200);

        yield* Scope.close(scope, Exit.void);
        expect(forwarder.routes().size).toBe(0);
        expect((yield* getRouted(origin)).status).toBe(502);
      }),
    ),
  );

  it.live("attaching the same fqn and listener again is idempotent", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const listener = yield* makeListener("api");
        const first = yield* Scope.make();
        const second = yield* Scope.make();
        const one = yield* Ingress.route(config, target, listener).pipe(Scope.provide(first));
        const two = yield* Ingress.route(config, target, listener).pipe(Scope.provide(second));
        expect(two).toBe(one);
        expect(forwarder.routes().size).toBe(1);

        // The later attach owns the route: the earlier scope leaves it alone.
        yield* Scope.close(first, Exit.void);
        expect((yield* getRouted(one)).status).toBe(200);
        yield* Scope.close(second, Exit.void);
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  );

  it.live("a new listener replaces the route and the old scope leaves it", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const before = yield* makeListener("before");
        const after = yield* makeListener("after");
        const first = yield* Scope.make();
        const second = yield* Scope.make();
        const origin = yield* Ingress.route(config, target, before).pipe(Scope.provide(first));
        expect((yield* getRouted(origin)).body).toMatch(/^before /);

        yield* Ingress.route(config, target, after).pipe(Scope.provide(second));
        expect((yield* getRouted(origin)).body).toMatch(/^after /);

        yield* Scope.close(first, Exit.void);
        expect((yield* getRouted(origin)).body).toMatch(/^after /);
        yield* Scope.close(second, Exit.void);
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  );

  it.live("routes for different fqns are independent", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const other: Ingress.IngressTarget = { ...target, fqn: "Web", id: "Web", label: "web" };
        const api = yield* makeListener("api");
        const web = yield* makeListener("web");
        const apiScope = yield* Scope.make();
        const apiOrigin = yield* Ingress.route(config, target, api).pipe(Scope.provide(apiScope));
        const webOrigin = yield* Ingress.route(config, other, web);
        expect(apiOrigin).not.toBe(webOrigin);
        expect((yield* getRouted(apiOrigin)).body).toMatch(/^api /);
        expect((yield* getRouted(webOrigin)).body).toMatch(/^web /);

        yield* Scope.close(apiScope, Exit.void);
        expect(forwarder.routes().has(other.fqn)).toBe(true);
        expect((yield* getRouted(webOrigin)).status).toBe(200);
      }),
    ),
  );

  it.live("a route the adapter refuses fails and leaves nothing routed", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Ingress.route(config, target, new URL("https://localhost:1337")),
        );
        assert(error instanceof Ingress.IngressError);
        expect(error.message).toContain("only routes http listeners");
        expect(forwarder.routes().size).toBe(0);
      }),
    ),
  );

  it.live("options reach the adapter", () =>
    withForwarder((forwarder) =>
      Effect.gen(function* () {
        const origin = yield* Ingress.origin(
          { type: FORWARDER_TYPE, options: { domain: "Shop" } },
          target,
        );
        expect(origin).toBe(`http://dev-alice.api.shop.localhost:${forwarder.port}`);
        expect(forwarder.made()).toEqual([{ domain: "Shop" }]);
      }),
    ),
  );

  it.live("an unknown type fails naming the type and the package to install", () =>
    Effect.gen(function* () {
      const failures = [
        yield* Effect.flip(Ingress.origin({ type: "nope" }, target)),
        yield* Effect.flip(Ingress.route({ type: "nope" }, target, new URL("http://localhost:1"))),
      ];
      for (const error of failures) {
        assert(error instanceof Ingress.IngressAdapterNotFound);
        expect(error.type).toBe("nope");
        expect(error.message).toContain('"nope"');
        expect(error.message).toContain("@alchemy.run/nope");
        expect(error.message).toContain("No installed package contributes an ingress adapter");
      }
    }).pipe(Effect.provide(Layer.merge(PlatformServices, FetchHttpClient.layer)), Effect.scoped),
  );

  it.live("a type that is only an Object.prototype name is unknown", () =>
    withForwarder(() =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Ingress.origin({ type: "toString" }, target));
        assert(error instanceof Ingress.IngressAdapterNotFound);
        expect(error.type).toBe("toString");
      }),
    ),
  );
});

describe("Ingress.createTarget", { tags: ["unit", "local"] }, () => {
  const resource = {
    stack: { name: "myapp", stage: "dev_alice" },
    id: "Build",
    fqn: "Web/Build",
    type: "Website.Server",
  };

  it("derives the target from the provider's identity", () => {
    expect(Ingress.createTarget(resource)).toEqual({
      stack: "myapp",
      stage: "dev_alice",
      fqn: "Web/Build",
      id: "Build",
      label: "Build",
      type: "Website.Server",
    });
  });

  it("a composite names the label after its site", () => {
    const derived = Ingress.createTarget({ ...resource, label: "Web" });
    expect(derived.label).toBe("Web");
    expect(derived.id).toBe("Build");
  });
});
