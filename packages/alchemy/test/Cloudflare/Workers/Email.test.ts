import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import * as emailSending from "@distilled.cloud/cloudflare/email-sending";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EmailTestWorker from "./fixtures/email-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Must match the fixture's `email-events@<zone>` literal matcher.
const inboxAddress = `email-events@${zoneName}`;

// Email Sending subdomain the test injects mail from. Deterministic name,
// disjoint from the SendingSubdomain suite's `alchemy-sendsub-*` names.
const sendingName = `alchemy-email-events.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return { accountId, zoneId: zone.id };
});

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * End-to-end inbound mail through the real Cloudflare pipeline, with no
 * external email infrastructure:
 *
 * 1. Deploy an Email Sending subdomain (DKIM/SPF DNS auto-provisioned on
 *    the Cloudflare-hosted test zone) plus the fixture Worker, whose
 *    `Cloudflare.email({ zone, matchers }).subscribe(...)` auto-creates
 *    the `Email.Routing` toggle and an `Email.Rule` routing
 *    `email-events@<zone>` to the Worker.
 * 2. Inject a unique-subject message out-of-band via the Email Sending
 *    HTTP API (`sendEmailSending`) from the sending subdomain to the
 *    inbox address. Delivery flows over real SMTP into the zone's Email
 *    Routing MX, matches the auto-created rule, and dispatches the
 *    Worker's `email` handler.
 * 3. Poll the Worker's `/received` snapshot (backed by a DO) until the
 *    subject shows up. Sends are repeated with the same subject across
 *    poll rounds to ride out routing-rule propagation right after deploy.
 */
test.provider(
  "deployed worker receives inbound mail routed by the auto-created EmailRule",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, zoneId } = yield* resolveZoneId;
      const client = yield* HttpClient.HttpClient;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const sending = yield* Cloudflare.Email.SendingSubdomain(
            "EmailEventsSending",
            { zoneId, name: sendingName },
          );
          const worker = yield* EmailTestWorker;
          return {
            url: worker.url.as<string>(),
            subdomainId: sending.subdomainId,
          };
        }),
      );

      const url = deployed.url;

      // Reset DO state; doubles as the readiness probe — fresh workers.dev
      // URLs take a few seconds to start serving 200s.
      yield* Effect.gen(function* () {
        const res = yield* client.post(`${url}/reset`);
        if (res.status !== 200) {
          return yield* new WorkerNotReady({ status: res.status });
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const resetAt = Date.now();

      // Sending is rejected until the subdomain's auto-provisioned DNS
      // records validate — usually immediate on Cloudflare DNS.
      yield* poll({
        description: "email sending subdomain enabled",
        effect: emailSending.getSubdomain({
          zoneId,
          subdomainId: deployed.subdomainId,
        }),
        predicate: (subdomain) => subdomain.enabled,
        schedule: Schedule.max([
          Schedule.spaced("3 seconds"),
          Schedule.recurs(20),
        ]),
      });

      const subject = `alchemy email events ${resetAt}`;

      const send = emailSending
        .sendEmailSending({
          accountId,
          from: `probe@${sendingName}`,
          to: inboxAddress,
          subject,
          text: "alchemy EmailEventSource live test",
        })
        .pipe(
          // A freshly registered sending subdomain reports `enabled` right
          // away but rejects sends with `InvalidEmailContent` (code 10202)
          // until its DNS validation propagates (usually within a couple of
          // minutes on Cloudflare DNS) — ride that out.
          Effect.retry({
            while: (e) => e._tag === "InvalidEmailContent",
            schedule: Schedule.spaced("10 seconds"),
            times: 18,
          }),
        );

      const checkReceived = Effect.gen(function* () {
        const res = yield* client.get(`${url}/received`);
        if (res.status !== 200) return [];
        const body = (yield* res.json) as { received?: unknown };
        if (!Array.isArray(body.received)) return [];
        return body.received.filter(
          (
            r,
          ): r is { to: string; subject: string | null; receivedAt: number } =>
            typeof r === "object" &&
            r !== null &&
            (r as { subject?: unknown }).subject === subject,
        );
      }).pipe(Effect.catch(() => Effect.succeed([])));

      // Send, then poll for arrival; repeat the send across rounds (same
      // subject, so any late duplicate still matches) in case the first
      // message raced the freshly-created EmailRule.
      const received = yield* Effect.gen(function* () {
        yield* send;
        return yield* checkReceived.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (matches) => matches.length > 0,
            times: 6,
          }),
        );
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (matches) => matches.length > 0,
          times: 3,
        }),
      );

      expect(received.length).toBeGreaterThan(0);
      for (const msg of received) {
        expect(msg.to).toBe(inboxAddress);
        expect(msg.subject).toBe(subject);
        expect(msg.receivedAt).toBeGreaterThanOrEqual(resetAt);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 360_000 },
);
