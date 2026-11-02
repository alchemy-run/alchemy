import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** A second project the profile can deploy into. Without it, the suite that uses this skips. */
export const otherProject = process.env.STACKIT_TEST_OTHER_PROJECT;

export const OtherMetrics = Stackit.Observability.Instance("AlertEventSourceOtherInstance", {
  projectId: otherProject,
});

/** A Worker consuming the alerts of an instance that isn't in the profile's project. */
export default class AlertsOtherProjectWorker extends Cloudflare.Worker<AlertsOtherProjectWorker>()(
  "StackitAlertsOtherProjectWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    yield* Stackit.Observability.consumeAlerts(OtherMetrics, {}, () => Effect.void);
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide(Stackit.Observability.AlertEventSourceLive)),
) {}
