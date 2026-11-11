import * as AWS from "@alchemy.run/aws";
import * as Modal from "@alchemy.run/modal";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as app from "@distilled.cloud/modal/app";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Api from "./fixtures/api-server.ts";
import { AsyncApi } from "./fixtures/async-server.ts";
import ServicesFunction from "./fixtures/services-function.ts";
import { Services } from "./fixtures/services.ts";
import Web from "./fixtures/web-function.ts";
import { hostIdentity } from "./hostIdentity.ts";

const providers = Layer.mergeAll(Modal.providers(), AWS.providers(), hostIdentity);
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ModalServicesStack",
  { providers, state: AWS.state() },
  Effect.gen(function* () {
    const services = yield* Services;
    const host = yield* ServicesFunction;
    const web = yield* Web;
    const api = yield* Api;
    const asyncApi = yield* AsyncApi;
    return {
      url: host.functionUrl.as<string>(),
      appId: services.appId,
      webUrl: web.url,
      apiUrl: api.url,
      asyncApiUrl: asyncApi.url,
    };
  }),
);

// The fixture deploys a Lambda, a Worker and Modal runtimes; next to the rest
// of the Modal suite that takes longer than the default hook timeout.
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

/** GET a URL until it answers 2xx (fresh Modal containers cold-start). */
const getJson = <A>(url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(url)
      .pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }));
    return (yield* res.json) as A;
  });

const worker = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* getJson<A>(`${url}${path}`);
  });

const tags = (kind: string) => ["provider:modal", `provider:modal:${kind}`, "provider:aws", "live"];

describe("Modal.Function", () => {
  test.provider(
    "the App publishes every function and server of the Stack",
    () =>
      Effect.gen(function* () {
        const { appId } = yield* stack;
        const { appLayout } = yield* app.appGetLayout({ appId });
        expect(Object.keys(appLayout?.functionIds ?? {}).sort()).toEqual(
          ["Api", "AsyncApi", "AsyncEmbed", "Embed.*", "Relay.*", "Web"].sort(),
        );
      }),
    { tags: tags("function"), timeout: 900_000 },
  );

  test(
    "a web function serves its fetch handler at its URL",
    Effect.gen(function* () {
      const { webUrl } = yield* stack;
      expect(webUrl).toMatch(/^https:\/\/.+\.modal\.run/);
      const body = yield* getJson<{ kind: string; path: string }>(`${webUrl}/direct`);
      expect(body).toEqual({ kind: "web", path: "/direct" });
    }),
    { tags: tags("function"), timeout: 300_000 },
  );
});

describe("Modal.Server", () => {
  test(
    "a server rejects requests without proxy auth",
    Effect.gen(function* () {
      const { apiUrl } = yield* stack;
      expect(apiUrl).toMatch(/^https:\/\//);
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(`${apiUrl}/hello`);
      expect(res.status).toBe(401);
    }),
    { tags: tags("server"), timeout: 300_000 },
  );

  test(
    "an unauthenticated async server answers directly",
    Effect.gen(function* () {
      const { asyncApiUrl } = yield* stack;
      const body = yield* getJson<{ kind: string; greeting: string }>(`${asyncApiUrl}/`);
      expect(body).toEqual({ kind: "async-server", greeting: "hello from an async server" });
    }),
    { tags: tags("server"), timeout: 300_000 },
  );
});

describe("InvokeFunction", () => {
  test(
    "call an Effect function's RPC method",
    Effect.gen(function* () {
      const body = yield* worker<{ model: string; tokens: number }>("/call");
      expect(body).toEqual({ model: "words", tokens: 3 });
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "a method's typed failure reaches the caller",
    Effect.gen(function* () {
      const body = yield* worker<{ _tag: string; reason: string }>("/call-fails");
      expect(body._tag).toBe("EmbedRejected");
      expect(body.reason).toBe("asked to fail");
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "a method's stream arrives whole",
    Effect.gen(function* () {
      expect(yield* worker<number[]>("/call-stream")).toEqual([1, 2, 3]);
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "a Modal Function calls a Function and a Server as its container",
    Effect.gen(function* () {
      const body = yield* worker<{
        embed: { tokens: number };
        greeting: string;
        tokenBound: boolean;
      }>("/relay");
      expect(body).toEqual({
        embed: { model: "words", tokens: 2 },
        greeting: "hello relay",
        tokenBound: false,
      });
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "call an async function with args and kwargs",
    Effect.gen(function* () {
      const body = yield* worker<{ greeting: string; echo: string; kwargs: unknown }>(
        "/call-async",
      );
      expect(body).toEqual({
        greeting: "hello from an async function",
        echo: "ping",
        kwargs: { source: "lambda" },
      });
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "map fans inputs out and keeps their order",
    Effect.gen(function* () {
      const body = yield* worker<Array<{ echo: string }>>("/map");
      expect(body.map((r) => r.echo)).toEqual(["a", "b c", "d e f"]);
    }),
    { tags: tags("function"), timeout: 300_000 },
  );

  test(
    "spawn a call and read its result",
    Effect.gen(function* () {
      const body = yield* worker<{ echo: string }>("/spawn");
      expect(body.echo).toBe("one two");
    }),
    { tags: tags("function"), timeout: 300_000 },
  );
});

describe("FetchServer", () => {
  test(
    "reach a proxy-auth server from a Lambda function",
    Effect.gen(function* () {
      const body = yield* worker<{ kind: string; path: string }>("/server");
      expect(body).toEqual({ kind: "server", path: "/hello" });
    }),
    { tags: tags("server"), timeout: 300_000 },
  );

  test(
    "call a server's RPC methods from a Lambda function",
    Effect.gen(function* () {
      const body = yield* worker<{ greeting: string; letters: string[] }>("/server-rpc");
      expect(body).toEqual({ greeting: "hello modal", letters: ["a", "b", "c"] });
    }),
    { tags: tags("server"), timeout: 300_000 },
  );

  test(
    "a server refuses an RPC call without its binding's key",
    Effect.gen(function* () {
      expect(yield* worker<{ status: number }>("/server-rpc-without-key")).toEqual({
        status: 401,
      });
    }),
    { tags: tags("server"), timeout: 300_000 },
  );

  test(
    "reach a web function from a Lambda function",
    Effect.gen(function* () {
      const body = yield* worker<{ kind: string; path: string }>("/web");
      expect(body).toEqual({ kind: "web", path: "/hello" });
    }),
    { tags: tags("function"), timeout: 300_000 },
  );
});

describe("ReadFunction", () => {
  test(
    "read a function's stats, calls and autoscaler",
    Effect.gen(function* () {
      yield* worker("/call");
      const body = yield* worker<{
        stats: { backlog: number };
        calls: number;
        autoscaler: unknown;
      }>("/read-function");
      expect(body.stats.backlog).toBeGreaterThanOrEqual(0);
      expect(body.calls).toBeGreaterThan(0);
    }),
    { tags: tags("function"), timeout: 300_000 },
  );
});

describe("ScaleFunction", () => {
  test(
    "override a function's autoscaler at runtime",
    Effect.gen(function* () {
      const body = yield* worker<{ scaledownWindow?: number }>("/scale");
      expect(body.scaledownWindow).toBe(120);
    }),
    { tags: tags("function"), timeout: 300_000 },
  );
});

describe("ReadServer", () => {
  test(
    "list a server's recent requests",
    Effect.gen(function* () {
      yield* worker("/server");
      const body = yield* worker<{ requests: Array<{ route?: string }>; containers: number }>(
        "/read-server",
      );
      expect(body.requests.length).toBeGreaterThan(0);
      expect(body.containers).toBeGreaterThanOrEqual(0);
    }),
    { tags: tags("server"), timeout: 300_000 },
  );
});

describe("ReadApp", () => {
  test(
    "read an App's layout, logs and deployments",
    Effect.gen(function* () {
      const body = yield* worker<{
        functions: string[];
        logs: number;
        tail: boolean;
        version: number;
      }>("/read-app");
      expect(body.functions).toContain("Embed.*");
      expect(body.tail).toBe(true);
      expect(body.version).toBeGreaterThan(0);
    }),
    { tags: tags("app"), timeout: 300_000 },
  );
});

describe("WriteApp", () => {
  test(
    "roll an App's containers over, then call it again",
    Effect.gen(function* () {
      expect(yield* worker<{ rolled: boolean }>("/rollover")).toEqual({ rolled: true });
      const body = yield* worker<{ tokens: number }>("/call");
      expect(body.tokens).toBe(3);
    }),
    { tags: tags("app"), timeout: 300_000 },
  );
});
