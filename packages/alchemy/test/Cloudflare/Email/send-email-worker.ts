import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Test fixture that binds four `send_email` variants on the same
 * Worker so the deploy assertion can read every shape back from
 * Cloudflare in a single round-trip.
 *
 * - `EMAIL_UNRESTRICTED`     — no destination/sender filter
 * - `EMAIL_DESTINATION`      — single `destinationAddress`
 * - `EMAIL_ALLOWED_DESTS`    — list of `allowedDestinationAddresses`
 * - `EMAIL_ALLOWED_SENDERS`  — list of `allowedSenderAddresses`
 */
export default class SendEmailWorker extends Cloudflare.Worker<SendEmailWorker>()(
  "SendEmailTestWorker",
  {
    main: import.meta.filename,
    compatibility: { date: "2024-09-23" },
  },
  Effect.gen(function* () {
    yield* Cloudflare.SendEmail.bind({ name: "EMAIL_UNRESTRICTED" });
    yield* Cloudflare.SendEmail.bind({
      name: "EMAIL_DESTINATION",
      destinationAddress: "ops@example.com",
    });
    yield* Cloudflare.SendEmail.bind({
      name: "EMAIL_ALLOWED_DESTS",
      allowedDestinationAddresses: ["ops@example.com", "alerts@example.com"],
    });
    yield* Cloudflare.SendEmail.bind({
      name: "EMAIL_ALLOWED_SENDERS",
      allowedSenderAddresses: ["noreply@example.com"],
    });

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.SendEmailLive)),
) {}
