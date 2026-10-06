import * as dns from "@distilled.cloud/cloudflare/dns";
import {
  createServiceDomain,
  deleteDomain,
  getDomain,
  getServiceDomains,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Output from "@/Output";
import * as Prisma from "@/Prisma";
import { PrismaApiError } from "@/Prisma/Client";
import * as Test from "@/Test/Alchemy";
import { artifactV1Path, expectDeploymentGone } from "./fixtures/DeploymentLive.ts";
import { expectGone, expectProjectGone, failureOf, patchStateAttr } from "./fixtures/Live.ts";
import { expectAppGone, expectBranchGone } from "./fixtures/ResourcesLive.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Cloudflare.providers()),
});

const liveTags = [
  "provider:prisma",
  "provider:prisma:app",
  "provider:prisma:customdomain",
  "provider:prisma:project",
  "live",
];

// A live domain needs an App with a started and promoted deployment. Without
// one the API refuses the create.
test.provider(
  "creating a domain on an App without a promoted deployment is rejected by Prisma",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (withDomain: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", { project });
        const domain = withDomain
          ? yield* Prisma.CustomDomain("Domain", {
              app,
              hostname: "alchemy-prisma-domain.example.com",
            })
          : undefined;
        return { project, app, domain };
      });

    const failure = yield* failureOf(stack.deploy(resources(true)));
    expect(
      failure.errors.some((error) => error instanceof PrismaApiError && error.status === 422),
    ).toBe(true);

    const { project, app } = yield* stack.deploy(resources(false));
    expect((yield* getServiceDomains({ serviceId: app.appId })).data).toEqual([]);

    yield* stack.destroy();
    yield* expectAppGone(app.appId);
    yield* expectProjectGone(project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

test.provider(
  "rejects a custom domain on an App attached to a non-default branch",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (withDomain: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/domain" });
        const app = yield* Prisma.App("Web", { project, branchId: branch.branchId });
        const domain = withDomain
          ? yield* Prisma.CustomDomain("Domain", {
              app,
              hostname: "alchemy-prisma-preview.example.com",
            })
          : undefined;
        return { project, branch, app, domain };
      });

    const failure = yield* failureOf(stack.deploy(resources(true)));
    expect(failure.text).toContain(
      "custom domains can only be attached to apps on the default Branch",
    );

    const { project, branch, app } = yield* stack.deploy(resources(false));
    expect((yield* getServiceDomains({ serviceId: app.appId })).data).toEqual([]);

    yield* stack.destroy();
    yield* expectAppGone(app.appId);
    yield* expectBranchGone(branch.branchId);
    yield* expectProjectGone(project.projectId);
  }),
  { tags: [...liveTags, "provider:prisma:branch"], timeout: 180_000 },
);

// Prisma verifies DNS before it accepts a domain, so the lifecycle owns a
// CNAME in the Cloudflare test zone pointing at the App region's switchboard.
const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const HOSTNAME = `alchemy-prisma-domain.${zoneName}`;
const SWITCHBOARD = "switchboard.ewr.prisma.build";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

const expectDomainGone = (domainId: string) =>
  expectGone(
    getDomain({ domainId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

/**
 * A default-branch App serving a promoted deployment of the checked-in
 * artifact, plus the CNAME. Prisma accepts a domain only once a deployment is
 * promoted, so the domain is deployed in a later step than the deployment. It
 * references the App rather than the deployment because an asserted
 * promotion reconciles on every deploy.
 */
const domainStack = (zoneId: string, options: { domain?: boolean; adopt?: boolean } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const app = yield* Prisma.App("Web", { project });
    const deployment = yield* Prisma.Deployment("Deployment", {
      app,
      artifactPath: artifactV1Path,
      promote: true,
    });
    const record = yield* Cloudflare.DNS.Record("Cname", {
      zoneId,
      name: HOSTNAME,
      type: "CNAME",
      content: SWITCHBOARD,
      ttl: 60,
      proxied: false,
    });
    if (!options.domain) {
      return { project, app, deployment, record, domain: undefined };
    }
    const resource = Prisma.CustomDomain("Domain", {
      app,
      // Spelled differently from the record; Prisma receives it normalized.
      hostname: Output.map(record.name, (name) => `${name.toUpperCase()}.`),
    });
    const domain = yield* options.adopt ? resource.pipe(adopt(true)) : resource;
    return { project, app, deployment, record, domain };
  });

const pendingStatuses = [
  "pending_dns",
  "verifying",
  "verified_routing_blocked",
  "provisioning_tls",
  "active",
];

test.provider(
  "attaches a domain to a promoted App, requires adoption for a foreign one, and deletes it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const zoneId = yield* resolveZoneId;

    const serving = yield* stack.deploy(domainStack(zoneId));
    expect(serving.deployment.status).toBe("running");
    const created = yield* stack.deploy(domainStack(zoneId, { domain: true }));
    const domain = created.domain!;
    expect(domain.appId).toBe(created.app.appId);
    expect(domain.hostname).toBe(HOSTNAME);
    // DNS is in place, so provisioning has started and has not failed.
    expect(pendingStatuses).toContain(domain.status);
    expect(domain.dnsRecords.length).toBeGreaterThan(0);
    const observed = (yield* getDomain({ domainId: domain.customDomainId })).data;
    expect(observed.appId).toBe(created.app.appId);
    expect(observed.hostname).toBe(HOSTNAME);
    expect(
      (yield* getServiceDomains({ serviceId: created.app.appId })).data.map((d) => d.id),
    ).toEqual([domain.customDomainId]);

    const settled = yield* stack.plan(domainStack(zoneId, { domain: true }));
    expect(settled.resources["Domain"]).toMatchObject({ action: "noop" });

    // A failed status in state forces a reconcile; the live domain has not
    // failed, so it is observed rather than retried.
    yield* patchStateAttr(stack, "Domain", { status: "failed" });
    const retryPlan = yield* stack.plan(domainStack(zoneId, { domain: true }));
    expect(retryPlan.resources["Domain"]).toMatchObject({ action: "update" });
    const reobserved = yield* stack.deploy(domainStack(zoneId, { domain: true }));
    expect(reobserved.domain!.customDomainId).toBe(domain.customDomainId);
    expect(pendingStatuses).toContain(reobserved.domain!.status);

    // Hostname changes cannot be replaced without risking traffic.
    const rename = yield* failureOf(
      stack.plan(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const app = yield* Prisma.App("Web", { project });
          const domain = yield* Prisma.CustomDomain("Domain", {
            app,
            hostname: `alchemy-prisma-domain-other.${zoneName}`,
          });
          return { project, app, domain };
        }),
      ),
    );
    expect(rename.text).toContain("cannot atomically replace");

    // Removing the resource deletes the domain and leaves the App in place.
    yield* stack.deploy(domainStack(zoneId));
    yield* expectDomainGone(domain.customDomainId);
    expect((yield* getServiceDomains({ serviceId: created.app.appId })).data).toEqual([]);

    // A domain attached out of band is refused, then adopted explicitly.
    const foreign = (yield* createServiceDomain({
      serviceId: created.app.appId,
      hostname: HOSTNAME,
    })).data;
    const refused = yield* failureOf(stack.deploy(domainStack(zoneId, { domain: true })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    expect((yield* getDomain({ domainId: foreign.id })).data.appId).toBe(created.app.appId);
    const adopted = yield* stack.deploy(domainStack(zoneId, { domain: true, adopt: true }));
    expect(adopted.domain!.customDomainId).toBe(foreign.id);

    // Deleted out of band: destroy treats it as already gone.
    yield* deleteDomain({ domainId: foreign.id });
    yield* expectDomainGone(foreign.id);

    yield* stack.destroy();
    yield* expectDeploymentGone(created.deployment.deploymentId);
    yield* expectAppGone(created.app.appId);
    yield* expectProjectGone(created.project.projectId);
    yield* expectGone(
      dns.getRecord({ zoneId, dnsRecordId: created.record.recordId }).pipe(
        Effect.as(false),
        Effect.catchTag("RecordNotFound", () => Effect.succeed(true)),
      ),
    );
  }),
  {
    tags: [...liveTags, "provider:prisma:deployment", "provider:cloudflare:dns"],
    timeout: 300_000,
  },
);
