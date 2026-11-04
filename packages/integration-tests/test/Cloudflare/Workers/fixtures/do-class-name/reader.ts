import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ClassNameHost, LensObject } from "./host.ts";

// Binds the host's `LensObject` cross-script: the binding must carry the
// physical class `LensServer`, not the logical id `LENS_DO`.
export default class ClassNameReader extends Cloudflare.Worker<ClassNameReader>()(
  "ClassNameReader",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* LensObject.from(ClassNameHost);

    return {
      fetch: Effect.gen(function* () {
        const value = yield* objects.getByName("lens").read();
        return yield* HttpServerResponse.json({ form: "class", value });
      }),
    };
  }),
) {}
