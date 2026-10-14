import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Cloudflare from "@/Cloudflare";
import { ProgramBox } from "./box.ts";

/** Owns one ProgramBox: writes a file, snapshots, and restores it into a fresh container. */
export class ProgramBoxObject extends Cloudflare.DurableObject<ProgramBoxObject>()(
  "ProgramBoxObject",
  Effect.gen(function* () {
    const box = yield* ProgramBox;
    return Effect.gen(function* () {
      const { fetch } = yield* box.getTcpPort(3000);
      const call = (path: string) =>
        fetch(HttpClientRequest.get(`http://container${path}`)).pipe(
          Effect.flatMap((response) => response.text),
        );
      return {
        // No image given: start() runs the Container's own image, the bundled program.
        writeAndRead: (text: string) =>
          box
            .start({ enableInternet: false })
            .pipe(
              Effect.andThen(call(`/write?text=${encodeURIComponent(text)}`)),
              Effect.andThen(call("/read")),
            ),
        snapshotRoundTrip: (text: string) =>
          Effect.gen(function* () {
            yield* box.start({ enableInternet: false });
            yield* call(`/write?text=${encodeURIComponent(text)}`);
            const snapshot = yield* box.snapshotContainer();
            yield* box.destroy();
            // A fresh container has lost the file…
            yield* box.start({ enableInternet: false });
            const fresh = yield* call("/read");
            yield* box.destroy();
            // …and the snapshot brings it back.
            yield* box.start({ enableInternet: false, containerSnapshot: { id: snapshot.id } });
            const restored = yield* call("/read");
            return { fresh, restored };
          }),
      };
    });
  }),
) {}
