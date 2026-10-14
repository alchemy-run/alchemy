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
      /** Memory the running sandbox's machine has, in bytes. */
      const memory = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* box.exec([
            "sh",
            "-c",
            "awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo",
          ]);
          const output = yield* child.output();
          return Number(new TextDecoder().decode(output.stdout).trim());
        }),
      );
      return {
        // The program is the sandbox's image: start() runs it.
        writeAndRead: (text: string) =>
          box
            .start({ size: "small", enableInternet: false })
            .pipe(
              Effect.andThen(call(`/write?text=${encodeURIComponent(text)}`)),
              Effect.andThen(call("/read")),
            ),
        /** Each size starts on its own instance type. */
        memoryAt: (size: "small" | "large") =>
          Effect.gen(function* () {
            yield* box.stop();
            yield* box.start({ size, enableInternet: false });
            // Wait for the program, so the machine is up.
            yield* call("/");
            const bytes = yield* memory;
            yield* box.stop();
            return bytes;
          }),
        snapshotRoundTrip: (text: string) =>
          Effect.gen(function* () {
            // Snapshots are a Cloudflare Container feature: reach the native container.
            const container = yield* Cloudflare.Containers.containerOf(box);
            yield* box.start({ size: "small", enableInternet: false });
            yield* call(`/write?text=${encodeURIComponent(text)}`);
            const snapshot = yield* container.snapshotContainer();
            yield* box.stop();
            // A fresh container has lost the file…
            yield* box.start({ size: "small", enableInternet: false });
            const fresh = yield* call("/read");
            yield* box.stop();
            // …and the snapshot brings it back.
            yield* container.start({
              instance: "lite",
              enableInternet: false,
              containerSnapshot: { id: snapshot.id },
            });
            const restored = yield* call("/read");
            return { fresh, restored };
          }),
      };
    });
  }),
) {}
