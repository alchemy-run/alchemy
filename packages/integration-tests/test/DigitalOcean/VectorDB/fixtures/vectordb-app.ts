import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const VectorsProject = DigitalOcean.Project("VectorsProject", {});

export const Vectors = Effect.gen(function* () {
  const project = yield* VectorsProject;
  return yield* DigitalOcean.VectorDB.Database("Vectors", { projectId: project.projectId });
});

/** Reads the Weaviate version through the bound endpoint and key. */
export default class VectorDbApp extends DigitalOcean.App<VectorDbApp>()(
  "VectorDbApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const db = yield* Vectors;
    const conn = yield* DigitalOcean.VectorDB.Connect(db);
    return {
      fetch: Effect.gen(function* () {
        const url = yield* conn.httpEndpoint;
        const key = yield* conn.apiKey;
        const client = yield* HttpClient.HttpClient;
        // The database's own endpoint, as the API returned it.
        const response = yield* client.execute(
          HttpClientRequest.get(`${url}/v1/meta`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(key)),
          ),
        );
        const meta = (yield* response.json) as { version?: string };
        return yield* HttpServerResponse.json({ status: response.status, version: meta.version });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.VectorDB.ConnectHttp)),
) {}
