import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Dataset } from "./resources.ts";

export class MountContainer extends Cloudflare.Container<MountContainer, {}>()("ArchilMount") {}

/** A Container that mounts the Dataset disk per request with its own disk user. */
export default MountContainer.make(
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    runtime: "node",
    observability: { logs: { enabled: true } },
  },
  Effect.gen(function* () {
    const dataset = yield* Archil.MountDisk(Dataset, { path: "/mnt/dataset", mode: "read-only" });
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const key = new URL(request.url, "http://container").searchParams.get("key") ?? "";
          yield* Effect.log(`mount: request for ${key}`);
          const path = yield* dataset.mount().pipe(
            Effect.timeoutOrElse({
              duration: "90 seconds",
              orElse: () => Effect.die("mount did not finish in 90s"),
            }),
          );
          yield* Effect.log(`mount: mounted at ${path}`);
          const body = yield* fs.readFileString(`${path}/${key}`).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.die(`mounted ${path}, but reading ${key} did not finish in 30s`),
            }),
          );
          yield* Effect.log(`mount: read ${body.length} bytes`);
          return HttpServerResponse.text(body);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Archil.MountDiskLive)),
);
