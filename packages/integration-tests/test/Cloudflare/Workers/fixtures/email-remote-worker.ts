import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const ZoneConfig = Config.String("CLOUDFLARE_TEST_DNS_ZONE_NAME").pipe(
  Config.withDefault("alchemy-test-2.us"),
);

/** The address the remote Worker's rule matches. */
export const remoteInbox = (zone: string) => `email-dev-remote@${zone}`;

/**
 * A Worker deployed with `Alchemy.remote()` under `alchemy dev`. It runs on
 * Cloudflare, so its subscription still provisions Email Routing. It matches
 * one address rather than the catch-all, which is a per-zone singleton other
 * suites use.
 */
export default class EmailRemoteWorker extends Cloudflare.Worker<EmailRemoteWorker>()(
  "EmailRemoteWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const zone = yield* ZoneConfig;

    yield* Cloudflare.email({
      zone,
      matchers: [{ type: "literal", field: "to", value: remoteInbox(zone) }],
    }).subscribe((message) => Effect.log(`received mail for ${message.to}`));

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
) {}
