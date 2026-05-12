import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  AllowedDestsSender,
  AllowedSendersSender,
  RestrictedDestSender,
  UnrestrictedSender,
} from "./sender.ts";

export default class SendEmailWorker extends Cloudflare.Worker<SendEmailWorker>()(
  "SendEmailTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23" },
  },
  Effect.gen(function* () {
    const unrestricted = yield* Cloudflare.SendEmail.bind(UnrestrictedSender);
    const restrictedDest =
      yield* Cloudflare.SendEmail.bind(RestrictedDestSender);
    const allowedDests = yield* Cloudflare.SendEmail.bind(AllowedDestsSender);
    const allowedSenders =
      yield* Cloudflare.SendEmail.bind(AllowedSendersSender);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/probe") {
          // Resolve the raw binding from each handle. We don't actually
          // call `.send()` (delivery requires a manually-verified sender),
          // but reading `raw` proves the bindings were wired into the
          // Worker env and that the typed client knows how to find them.
          const raw1 = yield* unrestricted.raw;
          const raw2 = yield* restrictedDest.raw;
          const raw3 = yield* allowedDests.raw;
          const raw4 = yield* allowedSenders.raw;
          return yield* HttpServerResponse.json({
            unrestricted: typeof raw1?.send,
            restrictedDest: typeof raw2?.send,
            allowedDests: typeof raw3?.send,
            allowedSenders: typeof raw4?.send,
          });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.SendEmailBindingLive)),
) {}
