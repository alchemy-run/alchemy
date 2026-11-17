import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export const GatewayDisk = Archil.Disk("GatewayDisk", {});

/**
 * A sandbox program that uploads and downloads a file as streams, through
 * disk bindings its gateway holds.
 */
export default class StreamingArchil extends Archil.Sandbox<StreamingArchil>()(
  "StreamingArchil",
  { main: import.meta.url, port: 3000, idleTtlSeconds: 300 },
  Effect.gen(function* () {
    const write = yield* Archil.WriteDisk(GatewayDisk);
    const read = yield* Archil.ReadDisk(GatewayDisk);
    return {
      fetch: Effect.gen(function* () {
        // 1 MiB in four chunks: sent as the stream produces them.
        const chunk = new Uint8Array(256 * 1024).fill(7);
        yield* write.upload("stream.bin", Stream.fromIterable([chunk, chunk, chunk, chunk]));
        const downloaded = yield* read.getStream("stream.bin").pipe(
          Stream.runFold(
            () => 0,
            (bytes, part) => bytes + part.length,
          ),
        );
        const listed = yield* read.list().pipe(
          Stream.map((object) => object.key),
          Stream.runCollect,
        );
        return yield* HttpServerResponse.json({ downloaded, listed: Array.from(listed) });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Archil.WriteDiskHttp, Archil.ReadDiskHttp).pipe(
        Layer.provide(Cloudflare.Workers.SandboxGateway),
      ),
    ),
  ),
) {}
