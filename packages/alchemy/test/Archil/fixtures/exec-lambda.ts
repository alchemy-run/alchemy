import * as Archil from "@/Archil/index.ts";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LambdaDisk } from "./disks.ts";

export class ArchilExecFunction extends Lambda.Function<Lambda.Function>()(
  "ArchilExecFunction",
) {}

/**
 * Lambda fixture exercising the same Archil {@link Archil.Connect} binding
 * from the Node runtime — the exact same capability layer as the Worker
 * fixture, proving the binding is host-agnostic.
 */
export default ArchilExecFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const data = yield* Archil.Connect(LambdaDisk);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (url.pathname === "/exec") {
          const result = yield* data
            .exec(
              "echo lambda-was-here > /mnt/archil/from-lambda.txt && cat /mnt/archil/from-lambda.txt",
            )
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Archil.ConnectHttp)),
);
