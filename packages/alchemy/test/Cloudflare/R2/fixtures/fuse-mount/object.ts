import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { FuseBox } from "./container.ts";

/**
 * The Durable Object hosting the FUSE container. Every operation is
 * wrapped in an `{ ok, value } | { ok, error }` envelope so the test
 * asserts on model-visible failure strings as easily as on successes.
 */
export class FuseObject extends Cloudflare.DurableObject<FuseObject>()(
  "FuseObject",
  Effect.gen(function* () {
    const box = yield* FuseBox;

    /** Run an operation, reporting failure as a value (never a defect). */
    const attempt = <A>(operation: Effect.Effect<A, string>) =>
      operation.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );

    return Effect.gen(function* () {
      return {
        mountPath: () => box.mountPath(),
        write: (name: string, content: string) =>
          attempt(box.write(name, content)),
        read: (name: string) => attempt(box.read(name)),
        list: () => attempt(box.list()),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(FuseBox, { enableInternet: true }),
    ),
  ),
) {}
