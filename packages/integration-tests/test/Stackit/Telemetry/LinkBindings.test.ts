import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import LinkBindingsOrgWorker, {
  FolderAudit,
  OrganizationAudit,
} from "./fixtures/link-worker-org.ts";
import LinkBindingsWorker, { Audit } from "./fixtures/link-worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const ProjectStack = Alchemy.Stack(
  "StackitLinkBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* LinkBindingsWorker;
    const link = yield* Audit;
    return { url: worker.url.as<string>(), linkId: link.linkId, routerId: link.routerId };
  }),
);

const OrgStack = Alchemy.Stack(
  "StackitLinkBindingsOrgStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* LinkBindingsOrgWorker;
    const folderLink = yield* FolderAudit;
    const organizationLink = yield* OrganizationAudit;
    return {
      url: worker.url.as<string>(),
      folderLinkId: folderLink.linkId,
      organizationLinkId: organizationLink.linkId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const OPTIONS = { timeout: 300_000 } as const;

/**
 * Retry until a route answers `ok`, because a fresh workers.dev URL, the created key and the
 * account's new memberships take a while to propagate. Then report the last answer, so a
 * real failure shows its error.
 */
const callOn = (url: string, route: string, params: Record<string, string> = {}) =>
  HttpClient.get(`${url}${route}?${new URLSearchParams(params).toString()}`).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

/**
 * One link per project and region, and this suite's link lives from `beforeAll` to `afterAll`.
 * The runner's `exclusive` label is only held while a hook or a test runs, so no label can keep
 * `Link.test.ts` off it. This flag runs the suite and turns off the cases there that share its
 * links, so the two never meet:
 * `STACKIT_TEST_LINK_BINDINGS=1 pnpm test:integration test/Stackit/Telemetry --profile testing`
 */
const noLinkBindings = !process.env.STACKIT_TEST_LINK_BINDINGS;

// The link is free, routers bill traffic only, and a backflush job has no delete, so jobs stay
// on the link until it goes. What a job replays is undocumented, so these only assert its record.
describe.sequential.skipIf(noLinkBindings)(
  "STACKIT Telemetry Link bindings on a Cloudflare Worker",
  { tags: [...stackitTags("telemetry", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(ProjectStack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ProjectStack), { timeout: 900_000 });

    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* callOn(url, route, params);
      });

    describe("GetProjectLink", () => {
      test.provider(
        "reads the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const { linkId } = yield* stack;
            const body = yield* call("/get-link");
            expectOk(body);
            expect(body.result.id).toEqual(linkId);
            expect(body.result.status).toEqual("active");
          }),
        OPTIONS,
      );
    });

    describe("BackflushProject", () => {
      test.provider(
        "starts a job on the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const body = yield* call("/backflush");
            expectOk(body);
            expect(body.result.displayName).toEqual("alchemy-replay");

            // Out of band: the job exists on this project's link.
            const job = yield* telemetry.getProjectBackflushJob({
              projectId,
              regionId: region,
              backflushJobId: body.result.id,
            });
            expect(job.id).toEqual(body.result.id);
          }),
        OPTIONS,
      );
    });

    describe("GetProjectBackflushJob", () => {
      test.provider(
        "reads a job by its id",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/backflush");
            expectOk(started);
            const body = yield* call("/get-job", { id: started.result.id });
            expectOk(body);
            expect(body.result.id).toEqual(started.result.id);
          }),
        OPTIONS,
      );
    });

    describe("ListProjectBackflushJobs", () => {
      test.provider(
        "lists a started job",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/backflush");
            expectOk(started);
            const body = yield* call("/list-jobs");
            expectOk(body);
            expect(body.result.backflushJobs.map((job: { id: string }) => job.id)).toContain(
              started.result.id,
            );
          }),
        OPTIONS,
      );
    });
  },
);

// Elevated rights in the test account: an organization- and a folder-scoped link.
describe.sequential.skipIf(noLinkBindings || !process.env.STACKIT_TEST_ORG_ROLES)(
  "STACKIT Telemetry Link bindings on a folder and an organization",
  { tags: [...stackitTags("telemetry", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(OrgStack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(OrgStack), { timeout: 900_000 });

    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* callOn(url, route, params);
      });

    describe("GetFolderLink", () => {
      test.provider(
        "reads the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const { folderLinkId } = yield* stack;
            const body = yield* call("/folder/get-link");
            expectOk(body);
            expect(body.result.id).toEqual(folderLinkId);
          }),
        OPTIONS,
      );
    });

    describe("BackflushFolder", () => {
      test.provider(
        "starts a job on the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/folder/backflush");
            expectOk(body);
            expect(body.result.displayName).toEqual("alchemy-replay");
          }),
        OPTIONS,
      );
    });

    describe("GetFolderBackflushJob", () => {
      test.provider(
        "reads a job by its id",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/folder/backflush");
            expectOk(started);
            const body = yield* call("/folder/get-job", { id: started.result.id });
            expectOk(body);
            expect(body.result.id).toEqual(started.result.id);
          }),
        OPTIONS,
      );
    });

    describe("ListFolderBackflushJobs", () => {
      test.provider(
        "lists a started job",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/folder/backflush");
            expectOk(started);
            const body = yield* call("/folder/list-jobs");
            expectOk(body);
            expect(body.result.backflushJobs.map((job: { id: string }) => job.id)).toContain(
              started.result.id,
            );
          }),
        OPTIONS,
      );
    });

    describe("GetOrganizationLink", () => {
      test.provider(
        "reads the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationLinkId } = yield* stack;
            const body = yield* call("/organization/get-link");
            expectOk(body);
            expect(body.result.id).toEqual(organizationLinkId);
          }),
        OPTIONS,
      );
    });

    describe("BackflushOrganization", () => {
      test.provider(
        "starts a job on the bound link",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/organization/backflush");
            expectOk(body);
            expect(body.result.displayName).toEqual("alchemy-replay");
          }),
        OPTIONS,
      );
    });

    describe("GetOrganizationBackflushJob", () => {
      test.provider(
        "reads a job by its id",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/organization/backflush");
            expectOk(started);
            const body = yield* call("/organization/get-job", { id: started.result.id });
            expectOk(body);
            expect(body.result.id).toEqual(started.result.id);
          }),
        OPTIONS,
      );
    });

    describe("ListOrganizationBackflushJobs", () => {
      test.provider(
        "lists a started job",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* call("/organization/backflush");
            expectOk(started);
            const body = yield* call("/organization/list-jobs");
            expectOk(body);
            expect(body.result.backflushJobs.map((job: { id: string }) => job.id)).toContain(
              started.result.id,
            );
          }),
        OPTIONS,
      );
    });
  },
);
