import { getServiceDomains } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import type { CustomDomain as ApiCustomDomain } from "@/Prisma/Types";
import * as Test from "@/Test/Alchemy";
import { expectProjectGone, failureOf, patchStateAttr } from "./fixtures/Live.ts";
import { fakeCustomDomainProviders } from "./fixtures/ResourcesFake.ts";
import { expectAppGone, expectBranchGone } from "./fixtures/ResourcesLive.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:app",
  "provider:prisma:customdomain",
  "provider:prisma:project",
  "live",
];

// A live domain needs an App with a started and promoted deployment, which
// needs a real Compute build (see Compute.live.test.ts). Without one the API
// refuses the create, which is what the live tests below pin; the domain
// lifecycle itself runs against the fake further down.
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

const createdAt = "2026-01-01T00:00:00.000Z";

/**
 * A client-shaped domain cloud: CustomDomain still calls `PrismaClient`. Every
 * App sits on the default branch.
 */
const makeDomainCloud = () => {
  const domains = new Map<string, ApiCustomDomain>();
  const calls: Array<[string, unknown?]> = [];
  let nextId = 1;
  const state = { createAnswers200: false };
  const notFound = (path: string) =>
    new PrismaApiError({ method: "GET", path, status: 404, message: "not found" });
  const domain = (appId: string, hostname: string): ApiCustomDomain => {
    const id = `domain-${nextId++}`;
    return {
      id,
      type: "custom-domain",
      url: `https://api.prisma.test/v1/domains/${id}`,
      hostname,
      appId,
      status: "pending_dns",
      foundryStatus: "pending_dns",
      failureReason: null,
      failureCategory: null,
      certExpiresAt: null,
      dnsRecords: [{ type: "CNAME", name: hostname, value: `${appId}.prisma.build`, ttl: null }],
      createdAt,
      updatedAt: createdAt,
    };
  };
  const client = {
    listApps: () => Effect.succeed([]),
    listAppDomains: (appId: string) =>
      Effect.sync(() => {
        calls.push(["listAppDomains", appId]);
        return Array.from(domains.values()).filter((d) => d.appId === appId);
      }),
    getCustomDomain: (id: string) =>
      Effect.suspend(() => {
        const found = domains.get(id);
        return found ? Effect.succeed(found) : Effect.fail(notFound(`/v1/domains/${id}`));
      }),
    getApp: (appId: string) =>
      Effect.succeed({
        id: appId,
        type: "app",
        url: `https://api.prisma.test/v1/services/${appId}`,
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-main",
        latestDeploymentId: "deployment-1",
        appEndpointDomain: `${appId}.prisma.build`,
        createdAt,
      }),
    getBranch: (branchId: string) =>
      Effect.succeed({
        id: branchId,
        type: "branch",
        url: `https://api.prisma.test/v1/branches/${branchId}`,
        gitName: "main",
        isDefault: true,
        role: "production",
        createdAt,
        updatedAt: createdAt,
        project: {
          id: "project-1",
          url: "https://api.prisma.test/v1/projects/project-1",
          name: "app",
        },
      }),
    createAppDomain: (appId: string, input: { hostname: string }) =>
      Effect.sync(() => {
        calls.push(["createAppDomain", { appId, input }]);
        const created = domain(appId, input.hostname);
        domains.set(created.id, created);
        return state.createAnswers200
          ? { status: 200 as const, domain: created }
          : { status: 201 as const, domain: created };
      }),
    retryCustomDomain: (id: string) =>
      Effect.sync(() => {
        calls.push(["retryCustomDomain", id]);
        const retried: ApiCustomDomain = {
          ...domains.get(id)!,
          status: "verifying",
          foundryStatus: "provisioning",
          failureReason: null,
          failureCategory: null,
        };
        domains.set(id, retried);
        return retried;
      }),
    deleteCustomDomain: (id: string) =>
      Effect.sync(() => {
        calls.push(["deleteCustomDomain", id]);
        domains.delete(id);
      }),
  } as unknown as PrismaManagementClient;
  return { client, domains, calls, state, domain };
};

const fakeTags = ["unit", "provider:prisma", "provider:prisma:customdomain", "local"];

const lifecycleCloud = makeDomainCloud();
const lifecycle = Test.make({ providers: fakeCustomDomainProviders(lifecycleCloud.client) });

lifecycle.test.provider(
  "creates a domain with a normalized hostname, retries a failed one once, and deletes it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (hostname: string) =>
      Prisma.CustomDomain("Domain", { app: "app-1", hostname });

    const created = yield* stack.deploy(resources("API.Example.COM."));
    expect(created.appId).toBe("app-1");
    expect(created.hostname).toBe("api.example.com");
    expect(created.status).toBe("pending_dns");
    expect(created.dnsRecords[0]).toMatchObject({ type: "CNAME", name: "api.example.com" });
    expect(lifecycleCloud.calls).toContainEqual([
      "createAppDomain",
      { appId: "app-1", input: { hostname: "api.example.com" } },
    ]);

    const settled = yield* stack.plan(resources("API.Example.COM."));
    expect(settled.resources["Domain"]).toMatchObject({ action: "noop" });

    // A failed provisioning attempt reaches the retry endpoint exactly once.
    lifecycleCloud.domains.set(created.customDomainId, {
      ...lifecycleCloud.domains.get(created.customDomainId)!,
      status: "failed",
      failureReason: "DNS verification failed",
      failureCategory: "dns",
    });
    yield* patchStateAttr(stack, "Domain", { status: "failed" });
    const retryPlan = yield* stack.plan(resources("API.Example.COM."));
    expect(retryPlan.resources["Domain"]).toMatchObject({ action: "update" });
    const retried = yield* stack.deploy(resources("API.Example.COM."));
    expect(retried.customDomainId).toBe(created.customDomainId);
    expect(retried.status).toBe("verifying");
    expect(lifecycleCloud.calls.filter(([operation]) => operation === "retryCustomDomain")).toEqual(
      [["retryCustomDomain", created.customDomainId]],
    );

    // Hostname (and App) changes cannot be replaced without risking traffic.
    const rename = yield* failureOf(stack.plan(resources("other.example.com")));
    expect(rename.text).toContain("cannot atomically replace");

    yield* stack.destroy();
    expect(lifecycleCloud.calls).toContainEqual(["deleteCustomDomain", created.customDomainId]);
    expect(lifecycleCloud.domains.size).toBe(0);
  }),
  { tags: fakeTags },
);

const existingCloud = makeDomainCloud();
const existing = Test.make({ providers: fakeCustomDomainProviders(existingCloud.client) });

existing.test.provider(
  "requires explicit adoption for an existing domain matched by normalized hostname",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const foreign = {
      ...existingCloud.domain("app-1", "api.example.com"),
      status: "active" as const,
    };
    existingCloud.domains.set(foreign.id, foreign);
    const resources = Prisma.CustomDomain("Domain", {
      app: "app-1",
      hostname: "API.EXAMPLE.COM.",
    });

    const refused = yield* failureOf(stack.deploy(resources));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    expect(existingCloud.calls.map(([operation]) => operation)).not.toContain("createAppDomain");

    const adopted = yield* stack.deploy(resources.pipe(adopt(true)));
    expect(adopted.customDomainId).toBe(foreign.id);
    expect(adopted.status).toBe("active");

    // Deleted out of band: destroy treats the 404 as already gone.
    existingCloud.domains.delete(foreign.id);
    yield* stack.destroy();
    expect(existingCloud.calls.map(([operation]) => operation)).not.toContain("deleteCustomDomain");
  }),
  { tags: fakeTags },
);

const raceCloud = makeDomainCloud();
const race = Test.make({ providers: fakeCustomDomainProviders(raceCloud.client) });

race.test.provider(
  "routes a 200 create race through explicit adoption",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    raceCloud.state.createAnswers200 = true;
    const resources = Prisma.CustomDomain("Domain", { app: "app-1", hostname: "api.example.com" });
    const raced = yield* failureOf(stack.deploy(resources));
    raceCloud.state.createAnswers200 = false;
    expect(raced.text).toContain("explicit adoption");
    const [visible] = Array.from(raceCloud.domains.values());
    expect(visible?.hostname).toBe("api.example.com");

    const refused = yield* failureOf(stack.deploy(resources));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(resources.pipe(adopt(true)));
    expect(adopted.customDomainId).toBe(visible!.id);

    yield* stack.destroy();
    expect(raceCloud.domains.size).toBe(0);
  }),
  { tags: fakeTags },
);
