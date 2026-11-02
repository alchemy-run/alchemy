import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as scf from "@distilled.cloud/stackit/scf";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import CloudFoundryBindingsWorker, { Dev, Org } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitCloudFoundryBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* CloudFoundryBindingsWorker;
    const organization = yield* Org;
    const space = yield* Dev;
    return {
      url: worker.url.as<string>(),
      organizationId: organization.organizationId,
      organizationName: organization.name,
      platformId: organization.platformId,
      apiUrl: organization.apiUrl,
      projectId: organization.projectId,
      region: organization.region,
      spaceId: space.spaceId,
      spaceName: space.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const timeout = { timeout: 240_000 };

describe(
  "STACKIT Cloud Foundry bindings on a Cloudflare Worker",
  { tags: [...stackitTags("cloudfoundry", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_500_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_500_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while
    // to propagate: retry until the route answers `ok`, then report the last answer so a
    // real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** A quota the bound platform has, read out of band. */
    const aPlatformQuota = Effect.gen(function* () {
      const { projectId, region, platformId } = yield* stack;
      const quotas = yield* scf.listPlatformQuotas({
        projectId: projectId!,
        region: region!,
        platformId: platformId!,
      });
      expect(quotas.length).toBeGreaterThan(0);
      return quotas[0]!.guid;
    });

    describe("GetOrganization", () => {
      test.provider(
        "reads the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationId, organizationName } = yield* stack;
            const body = yield* call("/get-organization");
            expectOk(body);
            expect(body.result.guid).toEqual(organizationId);
            expect(body.result.name).toEqual(organizationName);
          }),
        timeout,
      );
    });

    describe("ListOrganizations", () => {
      test.provider(
        "lists the bound organization among those in its project",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationId } = yield* stack;
            const body = yield* call("/list-organizations");
            expectOk(body);
            expect(body.result.resources.map((o: { guid: string }) => o.guid)).toContain(
              organizationId,
            );
          }),
        timeout,
      );
    });

    describe("ListOrganizationQuotas", () => {
      test.provider(
        "lists quotas of the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-organization-quotas");
            expectOk(body);
            expect(body.result.length).toBeGreaterThan(0);
          }),
        timeout,
      );
    });

    describe("GetOrganizationQuota", () => {
      test.provider(
        "reads the quota the organization has",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, organizationId } = yield* stack;
            const organization = yield* scf.getOrganization({
              projectId: projectId!,
              region: region!,
              organizationId: organizationId!,
            });
            const body = yield* call("/get-organization-quota", {
              quotaId: organization.quotaId,
            });
            expectOk(body);
            expect(body.result.guid).toEqual(organization.quotaId);
          }),
        timeout,
      );
    });

    describe("ApplyOrganizationQuota", () => {
      test.provider(
        "applies a quota, which the organization then reports",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, organizationId } = yield* stack;
            const quotaId = yield* aPlatformQuota;
            const body = yield* call("/apply-organization-quota", { quotaId });
            expectOk(body);
            expect(body.result.quotaId).toEqual(quotaId);
            const after = yield* scf.getOrganization({
              projectId: projectId!,
              region: region!,
              organizationId: organizationId!,
            });
            expect(after.quotaId).toEqual(quotaId);
          }),
        timeout,
      );
    });

    describe("GetOrganizationUsageSummary", () => {
      test.provider(
        "reads usage, zero for an empty organization",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationId } = yield* stack;
            const body = yield* call("/get-organization-usage-summary");
            expectOk(body);
            expect(body.result.orgId).toEqual(organizationId);
            expect(body.result.usageSummary.startedInstances).toEqual(0);
          }),
        timeout,
      );
    });

    describe("GetSpace", () => {
      test.provider(
        "reads the bound space",
        (_stack) =>
          Effect.gen(function* () {
            const { spaceId, spaceName } = yield* stack;
            const body = yield* call("/get-space");
            expectOk(body);
            expect(body.result.guid).toEqual(spaceId);
            expect(body.result.name).toEqual(spaceName);
          }),
        timeout,
      );
    });

    describe("ListSpaces", () => {
      test.provider(
        "lists the space in the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { spaceId } = yield* stack;
            const body = yield* call("/list-spaces");
            expectOk(body);
            expect(body.result.resources.map((s: { guid: string }) => s.guid)).toEqual([spaceId]);
          }),
        timeout,
      );
    });

    describe("GetPlatform", () => {
      test.provider(
        "reads the platform the organization is on",
        (_stack) =>
          Effect.gen(function* () {
            const { platformId, apiUrl } = yield* stack;
            const body = yield* call("/get-platform");
            expectOk(body);
            expect(body.result.guid).toEqual(platformId);
            expect(body.result.apiUrl).toEqual(apiUrl);
          }),
        timeout,
      );
    });

    describe("ListPlatforms", () => {
      test.provider(
        "lists that platform",
        (_stack) =>
          Effect.gen(function* () {
            const { platformId } = yield* stack;
            const body = yield* call("/list-platforms");
            expectOk(body);
            expect(body.result.resources.map((p: { guid: string }) => p.guid)).toContain(
              platformId,
            );
          }),
        timeout,
      );
    });

    describe("ListPlatformQuotas", () => {
      test.provider(
        "lists the platform's quota plans",
        (_stack) =>
          Effect.gen(function* () {
            const quotaId = yield* aPlatformQuota;
            const body = yield* call("/list-platform-quotas");
            expectOk(body);
            expect(body.result.map((q: { guid: string }) => q.guid)).toContain(quotaId);
          }),
        timeout,
      );
    });

    describe("GetPlatformQuota", () => {
      test.provider(
        "reads a quota plan of the platform",
        (_stack) =>
          Effect.gen(function* () {
            const quotaId = yield* aPlatformQuota;
            const body = yield* call("/get-platform-quota", { quotaId });
            expectOk(body);
            expect(body.result.guid).toEqual(quotaId);
          }),
        timeout,
      );
    });

    test.provider(
      "the created account's grants stay on the bound project",
      (_stack) =>
        Effect.gen(function* () {
          const { projectId } = yield* stack;
          const { members } = yield* authorization.listMembers({
            resourceType: "project",
            resourceId: projectId!,
          });
          // One custom role per permission set, and no broad role for the created account.
          const accounts = members.filter((member) => /@sa\.stackit\.cloud$/.test(member.subject));
          const roles = accounts.map((member) => member.role);
          expect(roles).not.toContain("owner");
          expect(roles).not.toContain("editor");
          expect(roles.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  },
);
