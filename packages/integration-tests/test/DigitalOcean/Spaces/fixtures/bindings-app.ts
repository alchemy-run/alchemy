import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestRegistry } from "../../fixtures/app/shared.ts";

/** The bucket every binding route reads and writes. */
export const Files = DigitalOcean.Spaces.Bucket("Files", { region: "nyc3", forceDestroy: true });

/** One route per Spaces binding, each running as this App's scoped key. */
export default class BindingsApp extends DigitalOcean.App<BindingsApp>()(
  "BindingsApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const bucket = yield* Files;
    const putObject = yield* DigitalOcean.Spaces.PutObject(bucket);
    const getObject = yield* DigitalOcean.Spaces.GetObject(bucket);
    const headObject = yield* DigitalOcean.Spaces.HeadObject(bucket);
    const listObjects = yield* DigitalOcean.Spaces.ListObjectsV2(bucket);
    const deleteObject = yield* DigitalOcean.Spaces.DeleteObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        const key = url.searchParams.get("key") ?? "hello.txt";
        switch (url.pathname) {
          case "/put":
            yield* putObject({ Key: key, Body: "hello spaces", ContentType: "text/plain" });
            return HttpServerResponse.text("put");
          case "/get": {
            const object = yield* getObject({ Key: key });
            const text = object.Body ? yield* Stream.mkString(Stream.decodeText(object.Body)) : "";
            return HttpServerResponse.text(text);
          }
          case "/head": {
            const head = yield* headObject({ Key: key });
            return yield* HttpServerResponse.json({ contentType: head.ContentType });
          }
          case "/list": {
            const page = yield* listObjects({});
            return yield* HttpServerResponse.json({
              keys: (page.Contents ?? []).map((object) => object.Key),
            });
          }
          case "/delete":
            yield* deleteObject({ Key: key });
            return HttpServerResponse.text("deleted");
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DigitalOcean.Spaces.PutObjectHttp,
        DigitalOcean.Spaces.GetObjectHttp,
        DigitalOcean.Spaces.HeadObjectHttp,
        DigitalOcean.Spaces.ListObjectsV2Http,
        DigitalOcean.Spaces.DeleteObjectHttp,
      ),
    ),
  ),
) {}
