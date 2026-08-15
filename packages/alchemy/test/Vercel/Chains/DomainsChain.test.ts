/**
 * Wave E depth chain (DEPTH.md row 4) — Domains chain:
 *
 *   Domain (x2, `.example` reserved-TLD names) → DnsRecord → ProjectDomain
 *   on a Website.StaticSite (x2).
 *
 * Cycles: deploy full chain → update the record's value (in-place update;
 * Vercel re-mints the id but nothing else churns) → MOVE the record to the
 * second domain (replacement, both domains stay deployed per the engine
 * deadlock rule) → re-point the ProjectDomain at the second site's project
 * (replacement, both sites stay deployed) → destroy → census.
 *
 * Every cycle asserts BOTH what changed and what stayed stable
 * (domainIds, projectIds, deploymentIds, attachment identity).
 *
 * `.example` is a reserved TLD — the names can never be registered, so the
 * domains stay unresolvable (nameservers never point at Vercel). The
 * verification-state assertions are honest about that: team-level `.example`
 * domains report `verified: true` with pending `intendedNameservers`, and a
 * ProjectDomain whose apex lives on the same team verifies immediately.
 */
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as dns from "@distilled.cloud/vercel/dns";
import * as domains from "@distilled.cloud/vercel/domains";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read of a team domain via distilled. */
const getDomain = (name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* domains.getDomain({ domain: name, ...team }).pipe(
      Effect.map((res) => res.domain as typeof res.domain | undefined),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

/** Out-of-band read of a DNS record by id (id endpoint is team-agnostic). */
const getRecord = (recordId: string) =>
  dns.getDomainsRecordsByRecordId({ recordId }).pipe(
    Effect.map((r): dns.GetDomainsRecordsByRecordIdResponse | undefined => r),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/** Out-of-band: every user-created record in a zone with the given name. */
const listRecordsNamed = (domain: string, name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const body = yield* dns
      .getRecords({ domain, limit: "100", ...team })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (body === undefined || typeof body === "string") return [];
    return body.records.filter(
      (r) => r.name === name && r.creator !== "system",
    );
  });

/** Out-of-band: the project-domain attachment row, if present. */
const findProjectDomain = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const body = yield* projects
      .getProjectDomains({ idOrName: projectId, limit: 100, ...team })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    return body?.domains.find((d) => d.name === name);
  });

/** Typed bounded wait until a record id no longer resolves. */
const expectRecordGone = (recordId: string) =>
  Effect.gen(function* () {
    const gone = yield* getRecord(recordId).pipe(
      Effect.map((r) =>
        r === undefined ? ("gone" as const) : ("found" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

/** Typed bounded wait until a team domain no longer resolves. */
const expectDomainGone = (name: string) =>
  Effect.gen(function* () {
    const gone = yield* getDomain(name).pipe(
      Effect.map((d) =>
        d === undefined ? ("gone" as const) : ("found" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

/** Typed bounded wait until a project no longer resolves. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const gone = yield* projects
      .getProject({ idOrName: projectId, ...team })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s === "gone",
          times: 10,
        }),
      );
    expect(gone).toEqual("gone");
  });

/** Static-site fixture: src/index.html + a cp build script in a temp dir. */
const makeSiteFixture = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: `alchemy-vercel-chain-${marker}-`,
    });
    yield* Effect.addFinalizer(() =>
      Effect.ignore(fs.remove(dir, { recursive: true })),
    );
    yield* fs.makeDirectory(path.join(dir, "src"), { recursive: true });
    // dist is build output — keep it out of the memo input hash.
    yield* fs.writeFileString(path.join(dir, ".gitignore"), "dist\n");
    const buildSh = path.join(dir, "build.sh");
    yield* fs.writeFileString(
      buildSh,
      "#!/bin/sh\nmkdir -p dist\ncp src/index.html dist/index.html\n",
    );
    yield* fs.chmod(buildSh, 0o755);
    yield* fs.writeFileString(
      path.join(dir, "src", "index.html"),
      `<!doctype html>\n<html><body><h1>${marker}</h1></body></html>\n`,
    );
    return dir;
  });

test.provider(
  "domains chain: Domain -> DnsRecord -> ProjectDomain on StaticSite across 4 reconciliation cycles",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const APEX_A = "alchemy-vercel-chain-dom-a.example";
      const APEX_B = "alchemy-vercel-chain-dom-b.example";
      const ATTACHED = `app.${APEX_A}`;

      const dirA = yield* makeSiteFixture("site-a");
      const dirB = yield* makeSiteFixture("site-b");

      /**
       * One parameterized chain shape. Both domains and both sites stay
       * deployed in EVERY cycle — a deploy must never replace a resource
       * while simultaneously removing its old dependency (engine deadlock).
       */
      const deployChain = (opts: {
        readonly recordOn: "a" | "b";
        readonly recordValue: string;
        readonly attachTo: "a" | "b";
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const domainA = yield* Vercel.Domain("DomainA", { name: APEX_A });
            const domainB = yield* Vercel.Domain("DomainB", { name: APEX_B });
            const record = yield* Vercel.DnsRecord("ChainProbe", {
              domain: opts.recordOn === "a" ? domainA : domainB,
              type: "TXT",
              name: "chain-probe",
              value: opts.recordValue,
              comment: "alchemy DomainsChain depth test",
            });
            const siteA = yield* Vercel.Website.StaticSite("SiteA", {
              command: "./build.sh",
              cwd: dirA,
              outdir: "dist",
            });
            const siteB = yield* Vercel.Website.StaticSite("SiteB", {
              command: "./build.sh",
              cwd: dirB,
              outdir: "dist",
            });
            const attached = yield* Vercel.ProjectDomain("Attached", {
              project: opts.attachTo === "a" ? siteA : siteB,
              // Derived from the Domain output so the attachment has a real
              // dependency edge on DomainA (detach before domain delete).
              name: Output.interpolate`app.${domainA.name}`,
            });
            return { domainA, domainB, record, siteA, siteB, attached };
          }),
        );

      // ── Cycle 1: greenfield deploy of the whole chain ────────────────
      const c1 = yield* deployChain({
        recordOn: "a",
        recordValue: "chain-v1",
        attachTo: "a",
      });

      expect(c1.domainA.name).toEqual(APEX_A);
      expect(c1.domainB.name).toEqual(APEX_B);
      expect(c1.domainA.domainId.length).toBeGreaterThan(0);
      // Honest verification shape for reserved `.example` names: the team
      // domain reports verified, but the zone stays pending forever — the
      // name can never be registered, so Vercel reports NO nameservers
      // (observed live: both `nameservers` and `intendedNameservers` are
      // empty for reserved TLDs) and the domain never resolves.
      expect(c1.domainA.verified).toEqual(true);
      expect(c1.domainA.nameservers).toEqual([]);
      expect(c1.domainA.intendedNameservers).toEqual([]);

      expect(c1.record.domain).toEqual(APEX_A);
      expect(c1.record.type).toEqual("TXT");
      expect(c1.record.value).toEqual("chain-v1");

      expect(c1.siteA.projectId).toBeDefined();
      expect(c1.siteB.projectId).toBeDefined();
      expect(c1.siteA.projectId).not.toEqual(c1.siteB.projectId);
      expect(c1.siteA.deploymentId).not.toEqual("");

      expect(c1.attached.projectId).toEqual(c1.siteA.projectId);
      expect(c1.attached.name).toEqual(ATTACHED);
      expect(c1.attached.apexName).toEqual(APEX_A);
      // The apex is a domain-of-record on the SAME team, so the attachment
      // verifies immediately and carries no challenge.
      expect(c1.attached.verified).toEqual(true);
      expect(c1.attached.verification ?? []).toEqual([]);

      // Out-of-band verification via distilled.
      const obsDomainA = yield* getDomain(APEX_A);
      expect(obsDomainA?.id).toEqual(c1.domainA.domainId);
      const obsDomainB = yield* getDomain(APEX_B);
      expect(obsDomainB?.id).toEqual(c1.domainB.domainId);
      const obsRecord1 = yield* getRecord(c1.record.recordId);
      expect(obsRecord1?.value).toEqual("chain-v1");
      expect(obsRecord1?.domain).toEqual(APEX_A);
      const obsAttached1 = yield* findProjectDomain(
        c1.siteA.projectId,
        ATTACHED,
      );
      expect(obsAttached1).toBeDefined();
      expect(obsAttached1!.verified).toEqual(true);

      // ── Cycle 2: record VALUE update — in-place, nothing else churns ─
      const c2 = yield* deployChain({
        recordOn: "a",
        recordValue: "chain-v2",
        attachTo: "a",
      });

      // Changed: the record value (classified as an update — the record
      // stays in zone A; Vercel re-mints the id on every update, which is
      // platform behavior, not a replacement).
      expect(c2.record.value).toEqual("chain-v2");
      expect(c2.record.domain).toEqual(APEX_A);
      expect(c2.record.recordId).not.toEqual(c1.record.recordId);

      // Stable: domains, sites (no rebuild/redeploy), attachment.
      expect(c2.domainA.domainId).toEqual(c1.domainA.domainId);
      expect(c2.domainB.domainId).toEqual(c1.domainB.domainId);
      expect(c2.siteA.projectId).toEqual(c1.siteA.projectId);
      expect(c2.siteA.deploymentId).toEqual(c1.siteA.deploymentId);
      expect(c2.siteB.deploymentId).toEqual(c1.siteB.deploymentId);
      expect(c2.attached.projectId).toEqual(c1.attached.projectId);
      expect(c2.attached.name).toEqual(ATTACHED);
      expect(c2.attached.verified).toEqual(true);

      // Out-of-band: the old record id is gone, the new one carries v2, and
      // the zone holds exactly ONE chain-probe row (update left no orphan).
      const obsRecord2 = yield* getRecord(c2.record.recordId);
      expect(obsRecord2?.value).toEqual("chain-v2");
      yield* expectRecordGone(c1.record.recordId);
      const zoneARows2 = yield* listRecordsNamed(APEX_A, "chain-probe");
      expect(zoneARows2.length).toEqual(1);
      expect(zoneARows2[0]!.id).toEqual(c2.record.recordId);

      // ── Cycle 3: MOVE the record to domain B — replacement ───────────
      // Both domains remain deployed across the move (deadlock rule).
      const c3 = yield* deployChain({
        recordOn: "b",
        recordValue: "chain-v2",
        attachTo: "a",
      });

      // Changed: the record now lives in zone B under a new id.
      expect(c3.record.domain).toEqual(APEX_B);
      expect(c3.record.value).toEqual("chain-v2");
      expect(c3.record.recordId).not.toEqual(c2.record.recordId);

      // Stable: both domains, both sites, the attachment.
      expect(c3.domainA.domainId).toEqual(c1.domainA.domainId);
      expect(c3.domainB.domainId).toEqual(c1.domainB.domainId);
      expect(c3.siteA.deploymentId).toEqual(c1.siteA.deploymentId);
      expect(c3.siteB.deploymentId).toEqual(c1.siteB.deploymentId);
      expect(c3.attached.projectId).toEqual(c1.siteA.projectId);

      // Out-of-band: record present in zone B, fully gone from zone A.
      const obsRecord3 = yield* getRecord(c3.record.recordId);
      expect(obsRecord3?.domain).toEqual(APEX_B);
      yield* expectRecordGone(c2.record.recordId);
      const zoneARows3 = yield* listRecordsNamed(APEX_A, "chain-probe");
      expect(zoneARows3.length).toEqual(0);
      const zoneBRows3 = yield* listRecordsNamed(APEX_B, "chain-probe");
      expect(zoneBRows3.length).toEqual(1);

      // ── Cycle 4: re-point the ProjectDomain at SiteB's project ───────
      // Both sites remain deployed across the move (deadlock rule). The
      // same domain name cannot be attached to two projects at once, so
      // this replacement must be delete-first.
      const c4 = yield* deployChain({
        recordOn: "b",
        recordValue: "chain-v2",
        attachTo: "b",
      });

      // Changed: the attachment now points at SiteB's project.
      expect(c4.attached.projectId).toEqual(c1.siteB.projectId);
      expect(c4.attached.name).toEqual(ATTACHED);
      expect(c4.attached.apexName).toEqual(APEX_A);
      expect(c4.attached.verified).toEqual(true);

      // Stable: both sites survive the move untouched; the record and both
      // domains do not churn.
      expect(c4.siteA.projectId).toEqual(c1.siteA.projectId);
      expect(c4.siteA.deploymentId).toEqual(c1.siteA.deploymentId);
      expect(c4.siteB.deploymentId).toEqual(c1.siteB.deploymentId);
      expect(c4.record.recordId).toEqual(c3.record.recordId);
      expect(c4.domainA.domainId).toEqual(c1.domainA.domainId);
      expect(c4.domainB.domainId).toEqual(c1.domainB.domainId);

      // Out-of-band: attachment present on SiteB's project, gone from
      // SiteA's; SiteA's project itself still exists.
      const obsAttachedB = yield* findProjectDomain(
        c1.siteB.projectId,
        ATTACHED,
      );
      expect(obsAttachedB).toBeDefined();
      const obsAttachedA = yield* findProjectDomain(
        c1.siteA.projectId,
        ATTACHED,
      );
      expect(obsAttachedA).toBeUndefined();
      const team = yield* teamScope;
      const siteAProject = yield* projects.getProject({
        idOrName: c1.siteA.projectId,
        ...team,
      });
      expect(siteAProject.id).toEqual(c1.siteA.projectId);

      // ── Destroy + census ─────────────────────────────────────────────
      yield* stack.destroy();

      yield* expectRecordGone(c3.record.recordId);
      yield* expectDomainGone(APEX_A);
      yield* expectDomainGone(APEX_B);
      yield* expectProjectGone(c1.siteA.projectId);
      yield* expectProjectGone(c1.siteB.projectId);

      // Destroy again — the whole chain's delete path is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel, Effect.scoped),
  { timeout: 300_000 },
);

test.provider(
  "delete-first Domain replacement heals the child DnsRecord",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const APEX = "alchemy-vercel-chain-dom-repl.example";

      // `cdnEnabled` is immutable on the platform, so flipping it is a
      // delete-first replacement of the Domain under the SAME name. The
      // child record's domain NAME does not change, so the record is not
      // replaced — but deleting the zone physically destroys it, and the
      // record's reconcile must observe the loss and recreate it.
      const deployWith = (cdnEnabled: boolean | undefined) =>
        stack.deploy(
          Effect.gen(function* () {
            const domain = yield* Vercel.Domain("ReplDomain", {
              name: APEX,
              ...(cdnEnabled !== undefined ? { cdnEnabled } : {}),
            });
            const record = yield* Vercel.DnsRecord("Survivor", {
              domain,
              type: "TXT",
              name: "survivor",
              value: "still-here",
              comment: "alchemy DomainsChain parent-replacement test",
            });
            return { domain, record };
          }),
        );

      const c1 = yield* deployWith(undefined);
      expect(c1.record.domain).toEqual(APEX);
      const obs1 = yield* getRecord(c1.record.recordId);
      expect(obs1?.value).toEqual("still-here");

      // Flip the immutable flag — delete-first replacement of the parent.
      const c2 = yield* deployWith(false);
      expect(c2.domain.name).toEqual(APEX);

      // The child record must exist live after the parent was replaced.
      const survivors = yield* listRecordsNamed(APEX, "survivor");
      expect(survivors.length).toEqual(1);
      expect(survivors[0]!.value).toEqual("still-here");
      // And the state row must point at the live record.
      const obs2 = yield* getRecord(c2.record.recordId);
      expect(obs2).toBeDefined();
      expect(obs2!.value).toEqual("still-here");

      yield* stack.destroy();
      yield* expectDomainGone(APEX);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
