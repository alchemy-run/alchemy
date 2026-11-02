import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { FIXTURE_DOMAIN } from "./fixtures/certs.ts";
import CdnBindingsWorker, { Cdn, Domain } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitCdnBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* CdnBindingsWorker;
    const distribution = yield* Cdn;
    yield* Domain;
    return {
      url: worker.url.as<string>(),
      projectId: distribution.projectId,
      distributionId: distribution.distributionId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The custom domain and a purge may keep the distribution updating, so the bindings run one
// after another.
describe.sequential(
  "STACKIT CDN bindings on a Cloudflare Worker",
  { tags: [...stackitTags("cdn", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real
    // failure shows its STACKIT error.
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

    describe("GetDistribution", () => {
      test.provider(
        "reads the bound distribution",
        (_stack) =>
          Effect.gen(function* () {
            const { distributionId } = yield* stack;
            const body = yield* call("/get-distribution");
            expectOk(body);
            expect(body.result.distribution.id).toEqual(distributionId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListDistributions", () => {
      test.provider(
        "lists the project's distributions, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { distributionId } = yield* stack;
            const body = yield* call("/list-distributions");
            expectOk(body);
            const ids = (body.result.distributions as { id: string }[]).map((item) => item.id);
            expect(ids).toContain(distributionId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetCustomDomain", () => {
      test.provider(
        "reads the bound custom domain",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-custom-domain");
            expectOk(body);
            expect(body.result.customDomain.name).toEqual(FIXTURE_DOMAIN);
            expect(body.result.certificate.type).toEqual("custom");
          }),
        { timeout: 240_000 },
      );
    });

    describe("PurgeCache", () => {
      test.provider(
        "purges a path, which the purge history then lists",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, distributionId } = yield* stack;
            const body = yield* call("/purge-cache", { path: "/bindings-purge.txt" });
            expectOk(body);

            // Out of band: the path shows up in the purge history.
            const { response } = yield* cdn
              .findCachePaths({
                projectId: projectId!,
                distributionId: distributionId!,
                path: "bindings-purge",
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (paths) => paths.response.length > 0,
                  times: 24,
                }),
              );
            expect(response.map((entry) => entry.path)).toContain("/bindings-purge.txt");
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetCacheInfo", () => {
      test.provider(
        "reports the granular purge in its history",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/purge-cache", { path: "/bindings-info.txt" });
            const body = yield* call("/get-cache-info", { path: "/bindings-info.txt" });
            expectOk(body);
            expect(body.result.lastPurgeTime).toEqual(expect.any(String));
          }),
        { timeout: 240_000 },
      );
    });

    describe("FindCachePaths", () => {
      test.provider(
        "finds a purged path by substring",
        (_stack) =>
          Effect.gen(function* () {
            yield* call("/purge-cache", { path: "/bindings-find.txt" });
            const found = yield* call("/find-cache-paths", { path: "bindings-find" }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (body) => body.ok && body.result.response.length > 0,
                times: 24,
              }),
            );
            expectOk(found);
            expect((found.result.response as { path: string }[]).map((e) => e.path)).toContain(
              "/bindings-find.txt",
            );
          }),
        { timeout: 300_000 },
      );
    });

    describe("GetLogs", () => {
      test.provider(
        "answers with the log list",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-logs");
            expectOk(body);
            expect(body.result.logs).toEqual(expect.any(Array));
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetLogsSearchFilters", () => {
      test.provider(
        "answers with the filter values",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-logs-search-filters");
            expectOk(body);
            expect(Object.keys(body.result.dataCenter).sort()).toEqual([
              "AF",
              "ASIA",
              "EU",
              "NA",
              "SA",
            ]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetStatistics", () => {
      test.provider(
        "answers with the statistics records",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-statistics", { from: "2026-01-01T00:00:00Z" });
            expectOk(body);
            expect(body.result.records).toEqual(expect.any(Array));
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListWafCollections", () => {
      test.provider(
        "lists the rule collections, with the request collection",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-waf-collections");
            expectOk(body);
            const ids = (body.result.collections as { id: string }[]).map((item) => item.id);
            expect(ids).toContain("@builtin/crs/request");
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the worker's account holds only the CDN permissions it needs",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const scope = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(scope);
            const permissionsOf = (role: authorization.Role) =>
              role.permissions
                .map((permission) => permission.name)
                .sort()
                .join();
            const purge = roles.find(
              (role) =>
                role.id !== undefined &&
                permissionsOf(role) === "cdn.distribution.edit,cdn.distribution.update",
            );
            expect(purge?.name).toBeTruthy();

            const { members } = yield* authorization.listMembers(scope);
            const self = members.find((member) => member.role === purge!.name)?.subject;
            expect(self).toMatch(/@sa\.stackit\.cloud$/);

            const held = members
              .filter((member) => member.subject === self)
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
              .sort();
            expect(held).toEqual([
              "cdn.distribution.edit,cdn.distribution.update",
              "cdn.distribution.get",
              "cdn.distribution.get,cdn.distribution.list",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
