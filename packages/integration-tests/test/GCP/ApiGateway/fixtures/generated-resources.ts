import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** An API, one OpenAPI config, and a gateway serving it. */
const openApi = `swagger: "2.0"
info:
  title: alchemy-apigateway-probe
  version: "1.0.0"
schemes:
  - https
produces:
  - application/json
paths:
  /hello:
    get:
      operationId: helloGet
      x-google-backend:
        address: https://httpbin.org/get
      responses:
        "200":
          description: ok
`;

export const ProbeApi = GCP.ApiGateway.Api("ProbeApi", {});

export const ProbeConfig = Effect.gen(function* () {
  const api = yield* ProbeApi;
  return yield* GCP.ApiGateway.ApisConfig("ProbeConfig", {
    api: api.name,
    openapiDocuments: [{ document: { path: "openapi.yaml", contents: openApi } }],
  });
});

export const ProbeGateway = Effect.gen(function* () {
  const config = yield* ProbeConfig;
  return yield* GCP.ApiGateway.Gateway("ProbeGateway", {
    apiConfig: config.name,
    location: "us-central1",
  });
});
