import * as Kubernetes from "alchemy/Kubernetes";
import { Gke } from "./Gke.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files, FilesGCS } from "./Files.ts";

// #region show
export default Kubernetes.Deployment(
  "Api",
  Effect.gen(function* () {
    return { main: import.meta.url, cluster: yield* Gke, port: 3000 };
  }),
  Effect.gen(function* () {
    const files = yield* Files;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* files.upload(request.url, yield* request.text);
        return HttpServerResponse.empty({ status: 201 });
      })/*hide*/.pipe(Effect.orDie)/*end*/,
    };
  }).pipe(Effect.provide(FilesGCS)),
);
// #endregion show
