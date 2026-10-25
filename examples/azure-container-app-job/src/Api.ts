import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Bucket, FILES_PREFIX, LATEST_REPORT, type Report } from "./resources.ts";

/** File names the API accepts: letters, digits, `.`, `_`, `-`. */
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The HTTP side, on Azure Functions (Flex Consumption):
 *
 * - `GET /health` answers `ok`
 * - `PUT /files/:name` stores the request body as `files/<name>`
 * - `GET /report` returns the latest report (`404` until the job has run)
 *
 * Its managed identity gets **Storage Blob Data Contributor** on `Bucket`.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const container = yield* Bucket;
    const bucket = yield* Azure.Storage.BlobContainerReadWrite(container);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.url, "http://api");
        const [, collection, name] = pathname.split("/");

        if (collection === "health" && request.method === "GET") {
          return HttpServerResponse.text("ok");
        }

        if (collection === "files" && request.method === "PUT") {
          if (name === undefined || !FILE_NAME.test(name)) {
            return HttpServerResponse.text("invalid file name", { status: 400 });
          }
          const buffer = yield* request.arrayBuffer;
          const body = new Uint8Array(buffer);
          yield* bucket.put(`${FILES_PREFIX}${name}`, body);
          return yield* HttpServerResponse.json({ name, bytes: body.length }, { status: 201 });
        }

        if (collection === "report" && request.method === "GET") {
          const latest = yield* bucket.get(LATEST_REPORT);
          if (latest === undefined) {
            return HttpServerResponse.text("no report yet", { status: 404 });
          }
          const report = JSON.parse(latest.text()) as Report;
          return yield* HttpServerResponse.json(report);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
