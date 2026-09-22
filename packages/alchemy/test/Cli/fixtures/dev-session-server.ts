import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  PlatformServices,
  httpServer,
  runMain,
} from "alchemy/Util/PlatformServices";

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* Effect.sync(() => process.env.DEV_SESSION_DIR!);
  const server = yield* HttpServer.HttpServer;
  yield* server.serve(Effect.succeed(HttpServerResponse.text("ready")));
  yield* Effect.addFinalizer(() =>
    Effect.sleep("100 millis").pipe(
      Effect.andThen(
        fs.writeFileString(path.join(directory, "server.closed"), "closed"),
      ),
      Effect.orDie,
    ),
  );
  const pid = yield* Effect.sync(() => process.pid);
  yield* fs.writeFileString(path.join(directory, "pid"), String(pid));
  const url = HttpServer.formatAddress(server.address);
  yield* fs.writeFileString(path.join(directory, "url"), url);
  yield* Effect.sync(() => console.log(url));
  yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.provideMerge(
      httpServer(0, "127.0.0.1", { gracefulShutdownTimeout: 0 }),
      PlatformServices,
    ),
  ),
  runMain,
);
