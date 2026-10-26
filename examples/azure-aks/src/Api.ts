import * as Azure from "@alchemy.run/azure";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Cluster, Notes } from "./infra.ts";

/**
 * A notes API on AKS: a `Kubernetes.Deployment` in the tagged form. The
 * class declares the deployment, and the default export is
 * `Api.make(props, impl)`, a Layer pairing the props with the init Effect.
 *
 * - `GET /` answers `ok`.
 * - `PUT /notes/:key` stores the request body as the blob `notes/<key>`.
 * - `GET /notes/:key` returns it, or `404` when there is none.
 *
 * Alchemy bundles this file, pushes it as an image to an Azure Container
 * Registry it creates (no Docker needed; the cluster's kubelet gets
 * `AcrPull`), and applies the Kubernetes Deployment, Service, and
 * ServiceAccount. `BlobContainerReadWrite` makes Alchemy create a
 * user-assigned managed identity federated with the Deployment's
 * ServiceAccount (Microsoft Entra Workload ID) and grant it Storage Blob
 * Data Contributor on the `Notes` container only.
 */
export class Api extends Kubernetes.Deployment<Api>()("Api") {}

export default Api.make(
  // Props are an Effect so they can reference the cluster resource.
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    return {
      cluster,
      main: import.meta.url,
      port: 3000,
      replicas: 1,
      serviceType: "LoadBalancer" as const,
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
    };
  }),
  Effect.gen(function* () {
    const notes = yield* Azure.Storage.BlobContainerReadWrite(Notes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [collection, key] = url.pathname.split("/").filter(Boolean);

        if (collection === undefined && request.method === "GET") {
          return HttpServerResponse.text("ok");
        }

        if (collection === "notes" && key !== undefined) {
          const blob = `notes/${key}`;
          if (request.method === "PUT") {
            const body = yield* request.text.pipe(Effect.orDie);
            yield* notes.put(blob, body, { contentType: "text/plain" }).pipe(Effect.orDie);
            return HttpServerResponse.text("stored", { status: 201 });
          }
          if (request.method === "GET") {
            const note = yield* notes.get(blob).pipe(Effect.orDie);
            return note === undefined
              ? HttpServerResponse.text("not found", { status: 404 })
              : HttpServerResponse.text(note.text());
          }
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
);
