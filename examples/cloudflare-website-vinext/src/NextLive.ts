import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { BackendClient } from "./BackendClient";
import { FrontendApi } from "./NextApi";
import { FrontendHandlers } from "./NextHandlers";

const platformLayer = Layer.mergeAll(
  Etag.layer,
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  FileSystem.layerNoop({}),
  Path.layer,
);

const FrontendLive = HttpApiBuilder.layer(FrontendApi).pipe(
  Layer.provide(FrontendHandlers.pipe(Layer.provide(BackendClient.Default))),
  Layer.provide(platformLayer),
);

const httpHandler = HttpRouter.toWebHandler(FrontendLive, {
  disableLogger: true,
});

export const handleApiRequest = (request: Request) =>
  httpHandler.handler(request);
