import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ??
  process.env.CLOUDFLARE_TEST_R2_DOMAIN_ZONE_NAME ??
  "alchemy-test-2.us";

// Deterministic per-run hostnames on the standing test zone. Each rerun
// reuses the same hostnames (never derive names from Date.now()).
const domainSuffix = `alchemy-worker-domain-${process.env.PULL_REQUEST ?? process.env.USER}`;

const DECLARED_HOSTNAME = `wd1-${domainSuffix}.${zoneName}`;
const OUT_OF_BAND_HOSTNAME = `wd2-${domainSuffix}.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Retry rate-limit blips on the tests' own out-of-band verification calls.
const transientRetrySchedule = Schedule.exponential("500 millis");

const listAttachments = (hostname: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    return yield* workers.listDomains({ accountId, hostname }).pipe(
      Effect.map((r) =>
        (r.result ?? []).filter((d) => d.hostname === hostname),
      ),
      Effect.retry({
        while: (e) => e._tag === "TooManyRequests",
        schedule: transientRetrySchedule,
        times: 8,
      }),
    );
  });

const findAttachment = (hostname: string) =>
  listAttachments(hostname).pipe(Effect.map((ds) => ds[0]));

// Detach every worker-domain attachment for the given hostnames — purge
// leftovers from interrupted runs so tests start from a clean slate.
const purgeDomains = (...hostnames: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    yield* Effect.forEach(hostnames, (hostname) =>
      listAttachments(hostname).pipe(
        Effect.flatMap(
          Effect.forEach((d) =>
            d.id
              ? workers
                  .deleteDomain({ accountId, domainId: d.id })
                  .pipe(Effect.catch(() => Effect.void))
              : Effect.void,
          ),
        ),
      ),
    );
  });

// #942: an omitted `domain` prop must leave live attachments alone —
// including hostnames attached outside Alchemy — while `domain: []` is the
// explicit detach-all. The gate keys on declared intent (props), never on
// domains persisted in state, so state written by older providers that
// observed listDomains unconditionally cannot re-arm the destructive path.
test.provider.skipIf(!zoneName)(
  "omitted domain preserves live attachments; empty array detaches all",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeDomains(DECLARED_HOSTNAME, OUT_OF_BAND_HOSTNAME);

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        // Create — one declared custom domain.
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-01" },
              domain: [DECLARED_HOSTNAME],
            });
          }),
        );
        workerName = worker.workerName;

        expect(worker.domains).toEqual([`https://${DECLARED_HOSTNAME}`]);
        const declared = yield* findAttachment(DECLARED_HOSTNAME);
        expect(declared?.service).toEqual(worker.workerName);

        // Attach a second hostname to the same script out-of-band — the
        // reconciler never recorded it, so it is unmanaged drift.
        yield* workers
          .putDomain({
            accountId,
            hostname: OUT_OF_BAND_HOSTNAME,
            service: worker.workerName,
            zoneId,
          })
          .pipe(
            // Same eventual-consistency window as the provider's own
            // attachDomain: PUT domains right after putScript can race the
            // script registry and return WorkerNotFound.
            Effect.retry({
              while: (e): boolean =>
                e._tag === "WorkerNotFound" || e._tag === "TooManyRequests",
              schedule: transientRetrySchedule,
              times: 8,
            }),
          );

        // Update with `domain` omitted (compat date bump forces the
        // update): both attachments must survive — omission unmanages the
        // surface, it does not mean "detach everything".
        const unmanaged = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-02" },
            });
          }),
        );

        expect((yield* findAttachment(DECLARED_HOSTNAME))?.service).toEqual(
          worker.workerName,
        );
        expect((yield* findAttachment(OUT_OF_BAND_HOSTNAME))?.service).toEqual(
          worker.workerName,
        );
        // Previously-observed custom domains carry forward in state so
        // subsequent reads keep observing them.
        expect(unmanaged.domains).toContain(`https://${DECLARED_HOSTNAME}`);

        // `domain: []` is the explicit detach-all.
        const detached = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-02" },
              domain: [],
            });
          }),
        );

        expect(detached.domains).toHaveLength(0);
        expect(yield* findAttachment(DECLARED_HOSTNAME)).toBeUndefined();
        expect(yield* findAttachment(OUT_OF_BAND_HOSTNAME)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* purgeDomains(DECLARED_HOSTNAME, OUT_OF_BAND_HOSTNAME).pipe(
              Effect.ignore,
            );
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 300_000 },
);
