import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import AccessProtectedWorker from "./fixtures/access-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotYetProtected extends Data.TaggedError("NotYetProtected")<{
  status: number;
  location: string | null;
  bodyExcerpt: string;
}> {}

/**
 * Probe `url` without following redirects until Cloudflare Access
 * intercepts it — a 302 to the team's `cloudflareaccess.com` login page.
 * Freshly-deployed workers.dev URLs 404/530 briefly and then serve the
 * open worker until the Access policy propagates, so every non-intercepted
 * response is retried.
 */
const expectAccessLoginRedirect = (url: string) =>
  Effect.gen(function* () {
    const probe = Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(url, {
          signal,
          redirect: "manual",
          cache: "no-store",
        });
        const location = res.headers.get("location");
        if (
          res.status === 302 &&
          location !== null &&
          location.includes("cloudflareaccess.com")
        ) {
          return location;
        }
        const body = await res.text();
        throw new NotYetProtected({
          status: res.status,
          location,
          bodyExcerpt: body.slice(0, 200),
        });
      },
      catch: (e) =>
        e instanceof NotYetProtected
          ? e
          : new NotYetProtected({
              status: 0,
              location: null,
              bodyExcerpt: e instanceof Error ? e.message : String(e),
            }),
    });
    return yield* probe.pipe(
      Effect.retry({
        while: (e) => e._tag === "NotYetProtected",
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("1 second", 1.5),
            Schedule.spaced("5 seconds"),
          ]),
          Schedule.recurs(24),
        ]),
      }),
    );
  });

test.provider(
  "protect a Worker with worker + preview_worker destinations",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { worker, app, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* AccessProtectedWorker;
          const policy = yield* Cloudflare.Access.Policy("AllowExample", {
            name: "Allow example.com (worker access test)",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("WorkerAccessApp", {
            type: "self_hosted",
            name: "Access for alchemy worker-destination test",
            destinations: [
              Cloudflare.Access.Worker(worker),
              Cloudflare.Access.WorkerPreview(worker),
            ],
            policies: [policy],
          });
          return { worker, app, policy };
        }),
      );

      // The Worker exposes its immutable script id, and the Access app's
      // destinations resolved to it.
      expect(worker.scriptTag).toBeDefined();
      expect(worker.scriptTag!.length).toBeGreaterThan(0);
      expect(app.applicationId).toBeDefined();
      expect(app.aud.length).toBeGreaterThan(0);
      expect(policy.policyId.length).toBeGreaterThan(0);
      expect(app.destinations).toEqual(
        expect.arrayContaining([
          { type: "worker", workerId: worker.scriptTag },
          { type: "preview_worker", workerId: worker.scriptTag },
        ]),
      );

      // Out-of-band: Cloudflare recorded the worker destinations.
      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      });
      const liveDestinations = (
        live as unknown as {
          destinations?: ReadonlyArray<{
            type?: string | null;
            workerId?: string | null;
          }> | null;
        }
      ).destinations;
      expect(liveDestinations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "worker",
            workerId: worker.scriptTag,
          }),
          expect.objectContaining({
            type: "preview_worker",
            workerId: worker.scriptTag,
          }),
        ]),
      );

      // The workers.dev URL is now behind Access: an unauthenticated
      // request is redirected to the Access login page instead of reaching
      // the worker.
      const location = yield* expectAccessLoginRedirect(worker.url!);
      expect(location).toContain("cloudflareaccess.com");

      yield* stack.destroy();

      // The application is gone.
      const liveAfter = yield* zeroTrust
        .getAccessApplicationForAccount({ accountId, appId: app.applicationId })
        .pipe(
          Effect.map(() => "still-exists" as const),
          Effect.catchTag("AccessApplicationNotFound", () =>
            Effect.succeed("gone" as const),
          ),
        );
      expect(liveAfter).toBe("gone");
    }).pipe(logLevel),
  { timeout: 300_000 },
);
