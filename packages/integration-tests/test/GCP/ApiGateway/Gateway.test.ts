import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const spec = (route: string) => `swagger: "2.0"
info:
  title: alchemy-gateway-test
  version: "1.0.0"
schemes:
  - https
produces:
  - application/json
paths:
  /${route}:
    get:
      operationId: ${route}Get
      x-google-backend:
        address: https://httpbin.org/get
      responses:
        "200":
          description: ok
`;

const app = (route: string, config: "V1" | "V2", labels: Record<string, string>) =>
  Effect.gen(function* () {
    const api = yield* GCP.ApiGateway.Api("EdgeApi", {});
    const served = yield* GCP.ApiGateway.ApisConfig(config, {
      api: api.name,
      openapiDocuments: [{ document: { path: "openapi.yaml", contents: spec(route) } }],
    });
    const gateway = yield* GCP.ApiGateway.Gateway("EdgeGateway", {
      apiConfig: served.name,
      location: "us-central1",
      labels,
    });
    return { api, served, gateway };
  });

/** GET a route on the gateway until it serves the given status. */
const getStatus = (url: string, until: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.map((response) => response.status),
      Effect.catch(() => Effect.succeed(0)),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === until,
        times: 24,
      }),
    );
  });

const waitUntilGone = (name: string) =>
  apigateway.getProjectsLocationsGateways({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "a gateway serves its config, rolls out the next one, and is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* stack.deploy(app("hello", "V1", { env: "test" }));
      expect(v1.gateway.state).toEqual("ACTIVE");
      expect(v1.gateway.apiConfig).toEqual(v1.served.name);
      expect(v1.gateway.url).toMatch(/^https:\/\/.+\.gateway\.dev$/);

      const fetched = yield* apigateway.getProjectsLocationsGateways({ name: v1.gateway.name });
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(yield* getStatus(`${v1.gateway.url}/hello`, 200)).toEqual(200);

      // a new config rolls out in place: same gateway, the new route serves
      const v2 = yield* stack.deploy(app("orders", "V2", { env: "prod" }));
      expect(v2.gateway.name).toEqual(v1.gateway.name);
      expect(v2.gateway.defaultHostname).toEqual(v1.gateway.defaultHostname);
      expect(v2.gateway.apiConfig).toEqual(v2.served.name);
      expect(v2.gateway.labels).toEqual({ env: "prod" });
      expect(yield* getStatus(`${v2.gateway.url}/orders`, 200)).toEqual(200);

      const plan = yield* stack.plan(app("orders", "V2", { env: "prod" }));
      expect(plan.resources.EdgeGateway.action).toBe("noop");

      yield* stack.destroy();
      expect(yield* waitUntilGone(v1.gateway.name)).toEqual("gone");
    }).pipe(logLevel),
  // Gateway create ~11 min, config rollout ~6 min, delete several more.
  { tags: ["provider:gcp", "provider:gcp:apigateway", "live"], timeout: 2_700_000 },
);
