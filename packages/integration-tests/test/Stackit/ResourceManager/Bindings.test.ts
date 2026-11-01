import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import RmBindingsWorker, { Child, Team } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

// STACKIT requires a user among a new project's members, and the test profile
// authenticates as a service account, so the suite is gated on this variable.
const owner = process.env.STACKIT_TEST_PROJECT_OWNER;

const Stack = Alchemy.Stack(
  "StackitRmBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* RmBindingsWorker;
    const team = yield* Team;
    const childFolder = yield* Stackit.ResourceManager.Folder("RmBindingsChildFolder", {
      parentId: team.containerId,
    });
    const childProject = yield* Child;
    return {
      url: worker.url.as<string>(),
      folderContainerId: team.containerId,
      organizationId: team.parentId,
      childFolderContainerId: childFolder.containerId,
      childProjectId: childProject.projectId,
      childProjectContainerId: childProject.containerId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const containerIds = (body: Body) => body.result.items.map((item: any) => item.containerId);

describe.skipIf(!owner)(
  "STACKIT Resource Manager bindings",
  { tags: [...stackitTags("resourcemanager", "bindings"), "provider:cloudflare"] },
  () => {
    // Creating and deleting a project takes minutes.
    const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships
    // take a while to propagate: retry until the route answers `ok`, then report
    // the last answer so a real failure shows its STACKIT error.
    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* HttpClient.get(`${url}${route}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    describe("GetFolderDetails", () => {
      test.provider(
        "reads the bound folder",
        (_stack) =>
          Effect.gen(function* () {
            const { folderContainerId } = yield* stack;
            const body = yield* call("/folder");
            expectOk(body);
            expect(body.result.containerId).toBe(folderContainerId);
            expect(body.result.labels.purpose).toBe("bindings-test");
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetProject", () => {
      test.provider(
        "reads the bound project",
        (_stack) =>
          Effect.gen(function* () {
            const { childProjectId, childProjectContainerId } = yield* stack;
            const body = yield* call("/project");
            expectOk(body);
            expect(body.result.projectId).toBe(childProjectId);
            expect(body.result.containerId).toBe(childProjectContainerId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListFolders", () => {
      test.provider(
        "lists what is directly inside the bound folder",
        (_stack) =>
          Effect.gen(function* () {
            const { folderContainerId, childFolderContainerId } = yield* stack;
            const body = yield* call("/folders");
            expectOk(body);
            expect(containerIds(body)).toContain(childFolderContainerId);
            expect(containerIds(body)).not.toContain(folderContainerId);
          }),
        { timeout: 240_000 },
      );

      test.provider(
        "lists what is directly inside a bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { folderContainerId, childFolderContainerId } = yield* stack;
            const body = yield* call("/organization-folders");
            expectOk(body);
            expect(containerIds(body)).toContain(folderContainerId);
            expect(containerIds(body)).not.toContain(childFolderContainerId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListProjects", () => {
      test.provider(
        "lists the project inside the bound folder",
        (_stack) =>
          Effect.gen(function* () {
            const { childProjectContainerId } = yield* stack;
            const body = yield* call("/projects");
            expectOk(body);
            expect(containerIds(body)).toEqual([childProjectContainerId]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetOrganization", () => {
      test.provider(
        "reads the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationId } = yield* stack;
            const body = yield* call("/organization");
            expectOk(body);

            const expected = yield* resourceManager.getOrganization({ id: organizationId! });
            expect(body.result.organizationId).toBe(expected.organizationId);
            expect(body.result.name).toBe(expected.name);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListOrganizations", () => {
      test.provider(
        "sees exactly the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { organizationId } = yield* stack;
            const expected = yield* resourceManager.getOrganization({ id: organizationId! });
            const body = yield* call("/organizations");
            expectOk(body);
            expect(body.result.items.map((item: any) => item.organizationId)).toEqual([
              expected.organizationId,
            ]);
          }),
        { timeout: 240_000 },
      );
    });
  },
);
