import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { describe, expect, test as unitTest } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import ProtectedWorker, { fixtureBody } from "./fixtures/protected-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const previewScript = `export default { fetch() { return new Response("${fixtureBody}"); } };`;

class AccessProbeFailed extends Data.TaggedError("AccessProbeFailed")<{
  message: string;
}> {}

const fetchManual = (url: string, headers?: Record<string, string>) =>
  Effect.tryPromise(async (signal) => {
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      cache: "no-store",
      headers: {
        "cache-control": "no-cache",
        ...(headers ?? {}),
      },
    });
    const location = res.headers.get("location") ?? undefined;
    const body = await res.text();
    return { status: res.status, location, body };
  });

const isAccessRedirect = (res: {
  status: number;
  location: string | undefined;
}) =>
  (res.status === 302 || res.status === 301) &&
  (res.location?.includes(".cloudflareaccess.com") ?? false);

const pollUntil = <A>(
  effect: Effect.Effect<A, unknown>,
  until: (value: A) => boolean,
) =>
  effect.pipe(
    Effect.flatMap((value) =>
      until(value)
        ? Effect.succeed(value)
        : Effect.fail(
            new AccessProbeFailed({
              message: `probe not ready: ${JSON.stringify(value).slice(0, 300)}`,
            }),
          ),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "AccessProbeFailed",
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("1 second"),
          Schedule.spaced("5 seconds"),
        ]),
        Schedule.recurs(18),
      ]),
    }),
  );

const expectAccessRedirect = (url: string) =>
  pollUntil(fetchManual(url), isAccessRedirect);

const expectFixtureBody = (url: string, headers?: Record<string, string>) =>
  pollUntil(
    fetchManual(url, headers),
    (res) => res.status === 200 && res.body.includes(fixtureBody),
  );

const liveDestinations = (accountId: string, appId: string) =>
  zeroTrust
    .getAccessApplicationForAccount({ accountId, appId })
    .pipe(
      Effect.map(
        (app) =>
          (app as { destinations?: ReadonlyArray<unknown> | null })
            .destinations ?? [],
      ),
    );

test.provider(
  "typed not-found: get/delete of a missing Access application",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const missing = "00000000-0000-4000-8000-000000000000";
      const get = yield* zeroTrust
        .getAccessApplicationForAccount({
          accountId,
          appId: missing,
        })
        .pipe(Effect.result);
      expect(get._tag).toEqual("Failure");
      if (get._tag === "Failure") {
        expect(get.failure._tag).toEqual("AccessApplicationNotFound");
      }
      const del = yield* zeroTrust
        .deleteAccessApplicationForAccount({
          accountId,
          appId: missing,
        })
        .pipe(Effect.result);
      expect(del._tag).toEqual("Failure");
      if (del._tag === "Failure") {
        expect(del.failure._tag).toEqual("AccessApplicationNotFound");
      }
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider(
  "T1: worker destination → preview_worker → destroy (fixture-body oracle)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* ProtectedWorker;
          const preview = yield* Cloudflare.Worker("ProtectedPreview", {
            script: previewScript,
            version: { parent },
          });
          const policy = yield* Cloudflare.Access.Policy("ProtectAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("ProtectWorker", {
            type: "self_hosted",
            destinations: [{ type: "worker", workerId: parent.workerId }],
            policies: [policy.policyId],
          });
          return { parent, preview, app, policy };
        }),
      );

      expect(v1.parent.workerId).not.toEqual(v1.parent.workerName);
      expect(v1.app.domain).toBeUndefined();

      const sent = [{ type: "worker", workerId: v1.parent.workerId }];
      const echoed = yield* liveDestinations(accountId, v1.app.applicationId);
      // P2 — destination drift: if this fails, Cloudflare reorders/enriches
      // and bodyEqualsObserved needs a shared canonicalDestinations().
      expect(echoed).toEqual(sent);

      yield* expectAccessRedirect(v1.parent.url!);
      yield* expectAccessRedirect(v1.preview.url!);

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* ProtectedWorker;
          const preview = yield* Cloudflare.Worker("ProtectedPreview", {
            script: previewScript,
            version: { parent },
          });
          const policy = yield* Cloudflare.Access.Policy("ProtectAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("ProtectWorker", {
            type: "self_hosted",
            destinations: [
              { type: "preview_worker", workerId: parent.workerId },
            ],
            policies: [policy.policyId],
          });
          return { parent, preview, app };
        }),
      );

      expect(v2.app.applicationId).toEqual(v1.app.applicationId);
      expect(v2.app.aud).toEqual(v1.app.aud);
      expect(yield* liveDestinations(accountId, v2.app.applicationId)).toEqual([
        { type: "preview_worker", workerId: v2.parent.workerId },
      ]);

      yield* expectFixtureBody(v2.parent.url!);
      yield* expectAccessRedirect(v2.preview.url!);

      // Drop the Access app only — the Worker stays so both URLs should
      // serve the fixture body again.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* ProtectedWorker;
          const preview = yield* Cloudflare.Worker("ProtectedPreview", {
            script: previewScript,
            version: { parent },
          });
          yield* Cloudflare.Access.Policy("ProtectAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return { parent, preview };
        }),
      );

      yield* expectFixtureBody(v3.parent.url!);
      yield* expectFixtureBody(v3.preview.url!);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "T2: allow (redirect) then bypass+everyone (unique body, anonymous)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const enforced = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ProtectedWorker;
          const policy = yield* Cloudflare.Access.Policy("EnforceAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("PublicException", {
            type: "self_hosted",
            destinations: [{ type: "worker", workerId: worker.workerId }],
            policies: [policy.policyId],
          });
          return { worker, app };
        }),
      );

      yield* expectAccessRedirect(enforced.worker.url!);

      const bypassed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ProtectedWorker;
          const policy = yield* Cloudflare.Access.Policy("PublicBypass", {
            name: "Bypass everyone",
            decision: "bypass",
            include: [{ everyone: {} }],
          });
          const app = yield* Cloudflare.Access.Application("PublicException", {
            type: "self_hosted",
            destinations: [{ type: "worker", workerId: worker.workerId }],
            policies: [policy.policyId],
          });
          return { worker, app };
        }),
      );

      expect(bypassed.app.applicationId).toEqual(enforced.app.applicationId);
      yield* expectFixtureBody(bypassed.worker.url!);
      // Bypass still goes through Access (aud is present) but there is
      // no user identity — that is distinct from "Access did not run".
      const whoami = yield* pollUntil(
        fetchManual(`${bypassed.worker.url}/whoami`),
        (res) => res.status === 200 && res.body.includes('"aud"'),
      );
      const identity = JSON.parse(whoami.body) as {
        aud: string | null;
        email: string | null;
      };
      expect(identity.email).toBeNull();
      expect(identity.aud).toEqual(bypassed.app.aud);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "T3: service-token identity reaches the fixture body",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ProtectedWorker;
          const token = yield* Cloudflare.Access.ServiceToken("ProtectToken", {
            name: "alchemy-access-worker-protect",
          });
          const policy = yield* Cloudflare.Access.Policy("ServiceAuth", {
            name: "Service auth",
            decision: "non_identity",
            include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
          });
          const app = yield* Cloudflare.Access.Application("TokenApp", {
            type: "self_hosted",
            destinations: [{ type: "worker", workerId: worker.workerId }],
            policies: [policy.policyId],
          });
          return { worker, token, app };
        }),
      );

      // Service Auth (`non_identity`) has no IdP login: an unauthenticated
      // request is denied (403 Access error page), not redirected.
      const denied = yield* pollUntil(
        fetchManual(deployed.worker.url!),
        (res) => res.status === 403 && res.body.includes("Cloudflare Access"),
      );
      expect(denied.status).toEqual(403);

      const secret = deployed.token.clientSecret;
      expect(secret).toBeDefined();
      const headers = {
        "CF-Access-Client-ID": deployed.token.clientId,
        "CF-Access-Client-Secret": Redacted.value(secret!),
      };
      yield* expectFixtureBody(deployed.worker.url!, headers);

      const whoami = yield* pollUntil(
        fetchManual(`${deployed.worker.url}/whoami`, headers),
        (res) => res.status === 200 && !res.body.includes("anonymous"),
      );
      const identity = JSON.parse(whoami.body) as {
        aud: string | null;
        email: string | null;
        name: string | null;
        userUuid: string | null;
        accountId: string | null;
      };
      // Service tokens carry no user email. The Access JWT audience is
      // the application `aud`; user identity fields stay empty.
      expect(identity.email).toBeNull();
      expect(identity.aud).toEqual(deployed.app.aud);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "T4 / P1: duplicate worker-destination create is rejected (no silent clone)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ProtectedWorker;
          const policy = yield* Cloudflare.Access.Policy("DupAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("DupApp", {
            type: "self_hosted",
            destinations: [{ type: "worker", workerId: worker.workerId }],
            policies: [policy.policyId],
          });
          return { worker, app, policy };
        }),
      );

      const duplicate = yield* zeroTrust
        .createAccessApplicationForAccount({
          accountId,
          type: "self_hosted",
          name: "alchemy-dup-worker-dest",
          destinations: [
            { type: "worker", workerId: deployed.worker.workerId },
          ],
          policies: [deployed.policy.policyId],
        })
        .pipe(Effect.result);

      // P1 — a silent duplicate would require destination-set recovery.
      // A conflict must be a typed tag (not Forbidden: that is entitlement).
      if (duplicate._tag === "Success") {
        return yield* Effect.fail(
          new AccessProbeFailed({
            message:
              "P1: Cloudflare accepted a second app on the same worker destination — implement destination-set recovery",
          }),
        );
      }
      expect(duplicate.failure._tag).toEqual("AccessDestinationConflict");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

unitTest("worker-identity destinations are schema-covered (ungated)", () => {
  const destinations: Cloudflare.Access.ApplicationDestination[] = [
    { type: "worker", workerId: "script-tag" },
    { type: "preview_worker", workerId: "script-tag" },
    { type: "all_workers" },
    { type: "all_preview_workers" },
  ];
  expect(destinations.map((d) => d.type)).toEqual([
    "worker",
    "preview_worker",
    "all_workers",
    "all_preview_workers",
  ]);
});

const accountWideEnabled =
  process.env.CLOUDFLARE_TEST_ACCESS_ACCOUNT_WIDE === "1";

describe.skipIf(!accountWideEnabled)("account-wide Access (env-gated)", () => {
  test.provider(
    "T5: all_preview_workers with preflight and immediate teardown",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const existing = yield* zeroTrust.listAccessApplicationsForAccount
          .items({ accountId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).filter((app) =>
                (
                  (app as { destinations?: ReadonlyArray<{ type?: string }> })
                    .destinations ?? []
                ).some(
                  (d) =>
                    d.type === "all_preview_workers" ||
                    d.type === "all_workers",
                ),
              ),
            ),
          );
        if (existing.length > 0) {
          return yield* Effect.fail(
            new AccessProbeFailed({
              message: `refusing to touch ${existing.length} pre-existing account-wide Access app(s)`,
            }),
          );
        }

        yield* stack.destroy();

        yield* Effect.gen(function* () {
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* ProtectedWorker;
              const preview = yield* Cloudflare.Worker("AccountWidePreview", {
                script: previewScript,
                version: { parent },
              });
              const policy = yield* Cloudflare.Access.Policy(
                "AccountWideAllow",
                {
                  name: "Allow example.com",
                  decision: "allow",
                  include: [{ emailDomain: { domain: "example.com" } }],
                },
              );
              const app = yield* Cloudflare.Access.Application("AllPreviews", {
                type: "self_hosted",
                destinations: [{ type: "all_preview_workers" }],
                policies: [policy.policyId],
              });
              return { parent, preview, app };
            }),
          );

          yield* expectFixtureBody(deployed.parent.url!);
          yield* expectAccessRedirect(deployed.preview.url!);
        }).pipe(Effect.ensuring(stack.destroy()));
      }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
