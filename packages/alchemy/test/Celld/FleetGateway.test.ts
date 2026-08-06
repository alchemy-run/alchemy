import {
  FLEET_DEPLOYMENT_PATH,
  FLEET_DEPLOYMENT_VAR,
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
  makeGatewayFetch,
  timingSafeStringEqual,
} from "@/Celld/FleetGateway";
import { WorkerEnvironment } from "@/Cloudflare/Workers/Worker";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRequests from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const SECRET = "test-secret-value";

/**
 * A fake Durable Object namespace: `getByName` returns a raw stub whose
 * methods are what workerd's JSRPC stub would expose (async functions), plus
 * a web-style `fetch` for the pass-through path.
 */
const makeEnv = () => {
  const calls: { name: string; method: string; path: string; body: string }[] =
    [];
  const env = {
    [FLEET_SECRET_VAR]: SECRET,
    [FLEET_DEPLOYMENT_VAR]: "deploy-123",
    Counter: {
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          calls.push({
            name,
            method: request.method,
            path: new URL(request.url).pathname,
            body: await request.text(),
          });
          return new Response(`path:${new URL(request.url).pathname}`);
        },
      }),
    },
  };
  return { env, calls };
};

const request = (
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) =>
  HttpServerRequests.fromWeb(
    new Request(`http://fleet.internal${path}`, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
    }),
  );

const call = (
  req: HttpServerRequest,
  env: Record<string, unknown>,
  userFetch?: Parameters<typeof makeGatewayFetch>[0],
): Promise<{ status: number; text: string }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* makeGatewayFetch(userFetch);
      const context = yield* Effect.context();
      const web = HttpServerResponse.toWeb(response, { context });
      const text = yield* Effect.promise(() => web.text());
      return { status: web.status, text };
    }).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest, req),
        Layer.succeed(WorkerEnvironment, env),
      ]),
      Effect.scoped,
    ) as Effect.Effect<{ status: number; text: string }>,
  );

describe("Celld FleetGateway", () => {
  test("timingSafeStringEqual", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  test("DO routes require the fleet secret", async () => {
    const { env } = makeEnv();
    const denied = await call(
      request("/Counter/a/__rpc__/increment", { method: "POST", body: "[]" }),
      env,
    );
    expect(denied.status).toBe(401);

    const wrongSecret = await call(
      request("/Counter/a/__rpc__/increment", {
        method: "POST",
        body: "[]",
        headers: { [FLEET_SECRET_HEADER]: "nope" },
      }),
      env,
    );
    expect(wrongSecret.status).toBe(401);
  });

  test("RPC calls forward to the named instance's fetch (prefix stripped)", async () => {
    const { env, calls } = makeEnv();
    const response = await call(
      request("/Counter/room-1/__rpc__/increment", {
        method: "POST",
        body: JSON.stringify([5]),
        headers: { [FLEET_SECRET_HEADER]: SECRET },
      }),
      env,
    );
    expect(response.status).toBe(200);
    // The DO bridge serves the RPC protocol on its own fetch — the gateway's
    // job is auth + routing the request through with the prefix stripped.
    expect(calls).toEqual([
      {
        name: "room-1",
        method: "POST",
        path: "/__rpc__/increment",
        body: JSON.stringify([5]),
      },
    ]);
  });

  test("pass-through forwards to the instance fetch with the prefix stripped", async () => {
    const { env } = makeEnv();
    const response = await call(
      request("/Counter/room-1/some/nested/path?q=1", {
        headers: { [FLEET_SECRET_HEADER]: SECRET },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.text).toBe("path:/some/nested/path");
  });

  test("deployment probe returns the deployment id (authenticated)", async () => {
    const { env } = makeEnv();
    const denied = await call(request(FLEET_DEPLOYMENT_PATH), env);
    expect(denied.status).toBe(401);

    const ok = await call(
      request(FLEET_DEPLOYMENT_PATH, {
        headers: { [FLEET_SECRET_HEADER]: SECRET },
      }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ deploymentId: "deploy-123" });
  });

  test("non-DO paths fall through to the user fetch handler", async () => {
    const { env } = makeEnv();
    const response = await call(
      request("/hello"),
      env,
      Effect.succeed(HttpServerResponse.text("user-handler")),
    );
    expect(response.status).toBe(200);
    expect(response.text).toBe("user-handler");
  });

  test("non-DO paths 404 when the fleet has no user fetch", async () => {
    const { env } = makeEnv();
    const response = await call(request("/hello"), env);
    expect(response.status).toBe(404);
  });
});
