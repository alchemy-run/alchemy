import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Fly from "@/Fly";

/**
 * Service in its own App that binds `BOUND_SECRET` only when
 * `BOUND_SECRETS_MODE` is `on`, and serves what the Machine reads back.
 */
export default class BoundSecretsApi extends Fly.Service<BoundSecretsApi>()(
  "BoundSecretsApi",
  {
    main: import.meta.url,
    region: "iad",
    port: 3000,
    env: { PLAIN_VALUE: "plain" },
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const mode = yield* Config.String("BOUND_SECRETS_MODE");
    const secret = mode === "on" ? Redacted.value(yield* Config.Redacted("BOUND_SECRET")) : "unset";

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/secret")) {
          return yield* HttpServerResponse.json({ secret });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
