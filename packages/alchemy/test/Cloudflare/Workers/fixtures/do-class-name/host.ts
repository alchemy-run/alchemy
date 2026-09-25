import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/index";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// The class form of `async-host.ts`'s binding: the logical id stays `LENS_DO`
// (the binding's `env` key) and `className` keeps the physical class
// `LensServer`, so the host converts in place with no class migration.
export class LensObject extends Cloudflare.DurableObject<
  LensObject,
  {
    read: () => Effect.Effect<string | null, never, RuntimeContext>;
  }
>()("LENS_DO", { className: "LensServer" }) {}

export const LensObjectLive = LensObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      return {
        read: () =>
          state.storage
            .get<string>("value")
            .pipe(Effect.map((value) => value ?? null)),
      };
    });
  }),
);

// Declares `LensObject` in its contract so `LensObject.from(ClassNameHost)`
// type-checks in `reader.ts`.
export class ClassNameHost extends Cloudflare.Worker<
  ClassNameHost,
  {},
  LensObject
>()("ClassNameHost") {}

export default ClassNameHost.make(
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* LensObject;

    return {
      fetch: Effect.gen(function* () {
        const value = yield* objects.getByName("lens").read();
        return yield* HttpServerResponse.json({ form: "class", value });
      }),
    };
  }).pipe(Effect.provide(LensObjectLive)),
);
