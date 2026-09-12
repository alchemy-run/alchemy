import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { LocalFuseBox } from "./local-container.ts";

/** The dev-mode Durable Object hosting the FUSE container. */
export class LocalFuseObject extends Cloudflare.DurableObject<LocalFuseObject>()(
  "LocalFuseObject",
  Effect.gen(function* () {
    const box = yield* LocalFuseBox;

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
      Cloudflare.Containers.layer(LocalFuseBox, { enableInternet: true }),
    ),
  ),
) {}
