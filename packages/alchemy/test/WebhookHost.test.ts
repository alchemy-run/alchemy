import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { isResolved } from "@/Diff.ts";
import * as Http from "@/Http.ts";
import * as Plan from "@/Plan";
import { Platform, type Main, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  ServerHost,
} from "@/Runtime/Process.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, State } from "@/State";
import { makeWebhookRoutes, WebhookHost, withWebhookHost } from "@/WebhookHost.ts";

// A minimal process host (like AWS.EC2.Instance) that opts in to WebhookHost.
interface HostProps extends PlatformProps {
  main?: string;
}

interface Host extends Resource<"Test.WebhookHost", HostProps, { url: string | undefined }> {}

type HostServices = ServerHost | WebhookHost;
type HostShape = Main<HostServices>;

const Host: Platform<Host, HostServices, HostShape, HostRuntimeContext> = Platform(
  "Test.WebhookHost",
  {
    createRuntimeContext: (id: string) =>
      withWebhookHost(createHostRuntimeContext("Test.WebhookHost")(id)),
  },
);

const hostProvider = () =>
  Provider.succeed(Host, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ output }) {
      return output ?? { url: "https://host.example.com" };
    }),
    delete: Effect.fn(function* () {}),
  });

const { test } = Test.make({
  providers: hostProvider(),
  state: inMemoryState(),
});

const makePlan = <A, Err, Req>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({
      name: "test",
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.flatMap((stackSpec: any) => Plan.make(stackSpec)),
    Effect.provide(hostProvider()),
  );

/**
 * Run a host program on a fake `HttpServer` and return the handler it serves.
 * The program parks after `serve`, so it runs in a fiber the caller stops.
 */
const serveProgram = (program: Effect.Effect<void, never, any>) =>
  Effect.gen(function* () {
    const served = yield* Deferred.make<Http.HttpEffect<any>>();
    const fiber = yield* program.pipe(
      Effect.provideService(Http.HttpServer, {
        serve: (handler) => Deferred.succeed(served, handler as Http.HttpEffect<any>),
      }),
      Effect.scoped,
      Effect.forkChild,
    );
    const handler = yield* Deferred.await(served);
    return { handler, fiber };
  });

const request = (handler: Http.HttpEffect<any>, url: string, init?: RequestInit) =>
  handler.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(url, init)),
    ),
    Effect.scoped,
    Effect.map((response) => HttpServerResponse.toWeb(response)),
    Effect.flatMap((response) =>
      Effect.promise(async () => ({ status: response.status, body: await response.text() })),
    ),
  );

test(
  "makeWebhookRoutes answers only the exact claimed path",
  Effect.gen(function* () {
    const routes = makeWebhookRoutes("Api");
    yield* routes.route("/stripe/webhook", (req) =>
      Effect.promise(async () => new Response(`got ${await req.text()}`, { status: 202 })),
    );

    expect(routes.handle(new Request("https://api.example.com/other"))).toBeUndefined();
    expect(routes.handle(new Request("https://api.example.com/stripe/webhook/"))).toBeUndefined();

    const claimed = routes.handle(
      new Request("https://api.example.com/stripe/webhook?x=1", { method: "POST", body: "evt" }),
    );
    expect(claimed).toBeDefined();
    const response = yield* claimed!;
    expect(response.status).toBe(202);
    expect(yield* Effect.promise(() => response.text())).toBe("got evt");
  }),
  { tags: ["unit", "local"] },
);

test(
  "makeWebhookRoutes refuses a second handler on one path",
  Effect.gen(function* () {
    const routes = makeWebhookRoutes("Api");
    const handler = () => Effect.succeed(new Response(null));
    yield* routes.route("/hook", handler);
    const exit = yield* Effect.exit(routes.route("/hook", handler));
    expect(exit._tag).toBe("Failure");
  }),
  { tags: ["unit", "local"] },
);

test(
  "a host listener claims a request before the served fetch handler",
  Effect.gen(function* () {
    const ctx = createHostRuntimeContext("Test.Host")("api");
    yield* ctx.listen!((req) =>
      req.url.startsWith("/hook") ? Effect.succeed(HttpServerResponse.text("hook")) : undefined,
    );
    yield* ctx.serve(Effect.succeed(HttpServerResponse.text("fetch")));

    const { program } = yield* ctx.exports;
    const { handler, fiber } = yield* serveProgram(program);

    expect(yield* request(handler, "http://localhost/hook")).toEqual({
      status: 200,
      body: "hook",
    });
    expect(yield* request(handler, "http://localhost/other")).toEqual({
      status: 200,
      body: "fetch",
    });
    yield* Fiber.interrupt(fiber);
  }),
  { tags: ["unit", "local"] },
);

test(
  "a host with listeners but no fetch still serves them",
  Effect.gen(function* () {
    const ctx = createHostRuntimeContext("Test.Host")("consumer");
    yield* ctx.listen!((req) =>
      req.url === "/hook" ? Effect.succeed(HttpServerResponse.text("hook")) : undefined,
    );

    const { program } = yield* ctx.exports;
    const { handler, fiber } = yield* serveProgram(program);

    expect(yield* request(handler, "http://localhost/hook")).toEqual({ status: 200, body: "hook" });
    expect((yield* request(handler, "http://localhost/other")).status).toBe(404);
    yield* Fiber.interrupt(fiber);
  }),
  { tags: ["unit", "local"] },
);

test(
  "a host without listeners serves its fetch handler unchanged",
  Effect.gen(function* () {
    const ctx = createHostRuntimeContext("Test.Host")("plain");
    yield* ctx.serve(Effect.succeed(HttpServerResponse.text("fetch", { status: 201 })));

    const { program } = yield* ctx.exports;
    const { handler, fiber } = yield* serveProgram(program);
    expect(yield* request(handler, "http://localhost/hook")).toEqual({
      status: 201,
      body: "fetch",
    });
    yield* Fiber.interrupt(fiber);
  }),
  { tags: ["unit", "local"] },
);

test(
  "withWebhookHost gives a process host's program a WebhookHost during plan",
  Effect.gen(function* () {
    const plan = yield* Host(
      "Api",
      { main: "index.ts" },
      Effect.gen(function* () {
        const host = yield* WebhookHost;
        expect(host.LogicalId).toBe("Api");
        yield* host.bind("stripe-webhook:/stripe/webhook", {
          env: { STRIPE_WEBHOOK_SECRET: "whsec_test" },
        });
        yield* host.route("/stripe/webhook", () => Effect.succeed(new Response(null)));
        return {};
      }),
    ).pipe(makePlan);

    expect(plan.resources["Api"]?.action).toBe("create");
    expect(plan.resources["Api"]?.bindings).toEqual([
      {
        sid: "stripe-webhook:/stripe/webhook",
        action: "create",
        data: { env: { STRIPE_WEBHOOK_SECRET: "whsec_test" } },
      },
    ]);
  }),
  { tags: ["unit", "local"] },
);

test(
  "the process WebhookHost routes a delivery through the host's HTTP server",
  Effect.gen(function* () {
    const ctx = withWebhookHost(createHostRuntimeContext("Test.WebhookHost")("Api"));
    const self = {
      Type: "Test.WebhookHost",
      LogicalId: "Api",
      bind: () => Effect.void,
    };
    const host = yield* Effect.gen(function* () {
      return yield* WebhookHost;
    }).pipe(
      Effect.provide(
        ctx.hostServices!.pipe(
          Layer.provide(
            Layer.mergeAll(Layer.succeed(Self, self as never), Layer.succeed(RuntimeContext, ctx)),
          ),
        ),
      ),
    );
    yield* host.route("/stripe/webhook", (req) =>
      Effect.promise(async () => new Response(`ok ${req.method} ${await req.text()}`)),
    );

    const { program } = yield* ctx.exports;
    const { handler, fiber } = yield* serveProgram(program);

    expect(
      yield* request(handler, "http://localhost/stripe/webhook", { method: "POST", body: "evt" }),
    ).toEqual({ status: 200, body: "ok POST evt" });
    expect((yield* request(handler, "http://localhost/elsewhere")).status).toBe(404);
    yield* Fiber.interrupt(fiber);
  }),
  { tags: ["unit", "local"] },
);
