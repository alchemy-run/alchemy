import * as E2B from "@alchemy.run/e2b";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ProbeWebhook } from "./resources.ts";

/** An Effect program baked into a template: every sandbox boots serving it. */
export default class ProgramTemplate extends E2B.Template<ProgramTemplate>()(
  "ProgramTemplate",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const greeting = yield* Config.String("PROGRAM_GREETING").pipe(Config.withDefault("hello"));
    // A binding inside the sandbox: the template program reads a webhook.
    const webhook = yield* E2B.ReadWebhook(ProbeWebhook);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sandbox");
        if (url.pathname === "/webhook") {
          return yield* webhook.stats({}).pipe(
            Effect.flatMap((stats) =>
              HttpServerResponse.json({ stats: typeof stats.total === "number" }),
            ),
            // The test compares the body, so a failure shows its cause.
            Effect.catchCause((cause) => HttpServerResponse.json({ error: Cause.pretty(cause) })),
          );
        }
        return HttpServerResponse.text(`${greeting} from an E2B sandbox`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(E2B.ReadWebhookHttp)),
) {}
