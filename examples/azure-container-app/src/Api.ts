import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Environment, LOCATION, Notes } from "./resources.ts";

/**
 * A notes API on Azure Container Apps.
 *
 * - `GET /` answers `ok`.
 * - `PUT /notes/:key` stores the request body as the blob `notes/<key>`.
 * - `GET /notes/:key` returns it, or `404` when there is none.
 *
 * Alchemy bundles this file, pushes it as an image to a registry it
 * creates, and runs it with a system-assigned managed identity.
 * `BlobContainerReadWrite` grants that identity Storage Blob Data
 * Contributor on the `Notes` container only.
 */
export default class Api extends Azure.ContainerApps.ContainerApp<Api>()(
  "Api",
  Effect.gen(function* () {
    const environment = yield* Environment;
    return {
      main: import.meta.url,
      location: LOCATION,
      environmentId: environment.environmentId,
      cpu: 0.25,
      memory: "0.5Gi",
      // Scale to zero between requests; HTTP traffic wakes it up.
      template: { scale: { minReplicas: 0, maxReplicas: 1 } },
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
) {}
