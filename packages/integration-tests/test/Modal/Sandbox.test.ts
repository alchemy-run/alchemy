import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandbox from "@distilled.cloud/modal/sandbox";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import RuntimeFunction from "./fixtures/runtime-function.ts";
import { hostIdentity } from "./hostIdentity.ts";

const providers = Layer.mergeAll(
  Modal.providers(),
  AWS.providers(),
  Cloudflare.providers(),
  hostIdentity,
);
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ModalRuntimeStack",
  { providers, state: AWS.state() },
  Effect.gen(function* () {
    const host = yield* RuntimeFunction;
    return { url: host.functionUrl.as<string>() };
  }),
);

// The fixture deploys a Lambda, a Worker and Modal runtimes; next to the rest
// of the Modal suite that takes longer than the default hook timeout.
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

const get = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as A;
  });

const tags = ["provider:modal", "provider:modal:sandbox", "provider:aws", "live"];

test(
  "an Effect program runs in a sandbox and uses its bindings",
  Effect.gen(function* () {
    const body = yield* get<{ agent: string; files: number }>("/effect");
    expect(body.agent).toBe("effect");
    expect(typeof body.files).toBe("number");
  }),
  { tags, timeout: 600_000 },
);

test(
  "an async program runs in a sandbox with its env",
  Effect.gen(function* () {
    const body = yield* get<{ agent: string; greeting: string }>("/async");
    expect(body).toEqual({ agent: "async", greeting: "hello from async" });
  }),
  { tags, timeout: 600_000 },
);

test(
  "a program mounts a volume (MountVolume) and a Cloudflare R2 bucket (mounts)",
  Effect.gen(function* () {
    const body = yield* get<{ volume: string; bucket: string }>("/mounts?key=m1");
    expect(body).toEqual({ volume: "volume m1", bucket: "bucket m1" });
  }),
  { tags: [...tags, "provider:cloudflare"], timeout: 600_000 },
);

test(
  "getTcpPort fetch: client request",
  Effect.gen(function* () {
    const body = yield* get<{
      status: number;
      echo: string;
      body: { method: string; path: string; query: string; probe: string; body: string };
    }>("/port/client");
    expect(body).toEqual({
      status: 201,
      echo: "sandbox",
      body: {
        method: "POST",
        path: "/client/echo",
        query: "?x=1",
        probe: "client",
        body: "hello client",
      },
    });
  }),
  { tags, timeout: 600_000 },
);

test(
  "getTcpPort fetch: proxies a server request",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // Sent once: a proxied body can't be replayed, so no retry here.
    const response = yield* client.execute(
      HttpClientRequest.post(`${url}/port/proxy/echo?x=2`).pipe(
        HttpClientRequest.setHeader("x-probe", "proxy"),
        HttpClientRequest.bodyText("hello proxy"),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers["x-echo"]).toBe("sandbox");
    expect(yield* response.json).toEqual({
      method: "POST",
      path: "/port/proxy/echo",
      query: "?x=2",
      probe: "proxy",
      body: "hello proxy",
    });
  }),
  { tags, timeout: 600_000 },
);

test(
  "getTcpPort connect: a TCP socket through the tunnel",
  Effect.gen(function* () {
    const body = yield* get<{ statusLine: string; body: Record<string, string> }>("/port/connect");
    expect(body.statusLine).toBe("HTTP/1.1 201 Created");
    expect(body.body).toEqual({
      method: "GET",
      path: "/connect/echo",
      query: "?x=3",
      probe: "connect",
      body: "",
    });
  }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a sandbox a runtime creates carries its stack, stage and host as tags",
  () =>
    Effect.gen(function* () {
      const { sandboxId } = yield* get<{ sandboxId: string }>("/owned");
      const { tags } = yield* sandbox.sandboxTagsGetV2({ sandboxId });
      yield* sandbox.sandboxTerminateV2({ sandboxId });
      const byName = Object.fromEntries((tags ?? []).map((t) => [t.tagName, t.tagValue]));
      // The owner's keys win over a user tag of the same name; others stay.
      expect(byName["alchemy::stack"]).toBe("ModalRuntimeStack");
      expect(byName["alchemy::id"]).toBe("ModalRuntimeFunction");
      expect(byName["alchemy::stage"]).toBeTruthy();
      expect(byName.user).toBe("u1");
    }),
  { tags, timeout: 600_000 },
);
