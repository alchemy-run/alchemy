import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as git from "@distilled.cloud/stackit/git";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import GitBindingsWorker, {
  App,
  Ci,
  Forge,
  SEED_USERNAME,
  SeedUser,
  Sso,
} from "./fixtures/worker.ts";
import { slow } from "./git.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitGitBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* GitBindingsWorker;
    const forge = yield* Forge;
    const runner = yield* Ci;
    const app = yield* App;
    const sso = yield* Sso;
    yield* SeedUser;
    return {
      url: worker.url.as<string>(),
      projectId: forge.projectId,
      instanceId: forge.instanceId,
      instanceUrl: forge.url,
      runnerId: runner.runnerId,
      repositoryId: app.repositoryId,
      authenticationId: sso.authenticationId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const timeout = { timeout: 180_000 } as const;

describe.sequential.skipIf(slow)(
  "STACKIT Git bindings on a Cloudflare Worker",
  { tags: [...stackitTags("git", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_800_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real
    // failure shows its error.
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

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, instanceUrl } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toBe(instanceId);
            expect(body.result.url).toBe(instanceUrl);
            expect(body.result.state).toBe("Ready");
          }),
        timeout,
      );
    });

    describe("ListInstances", () => {
      test.provider(
        "lists the project's instances, the bound one among them",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/list-instances");
            expectOk(body);
            expect(body.result.instances.map((instance: { id: string }) => instance.id)).toContain(
              instanceId,
            );
          }),
        timeout,
      );
    });

    describe("GetRunner", () => {
      test.provider(
        "reads the bound runner",
        (_stack) =>
          Effect.gen(function* () {
            const { runnerId } = yield* stack;
            const body = yield* call("/get-runner");
            expectOk(body);
            expect(body.result.id).toBe(runnerId);
            expect(body.result.labels).toEqual(["stackit-docker"]);
          }),
        timeout,
      );
    });

    describe("CreateUser", () => {
      test.provider(
        "creates a user, which shows up out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, instanceId } = yield* stack;
            const body = yield* call("/create-user", { username: "alchemy-bindings-created" });
            expectOk(body);
            expect(body.result.username).toBe("alchemy-bindings-created");
            const fetched = yield* git.getUser({
              projectId: projectId!,
              instanceId: instanceId!,
              username: "alchemy-bindings-created",
            });
            expect(fetched.name).toBe("Created by a binding");
          }),
        timeout,
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads a user",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-user", { username: SEED_USERNAME });
            expectOk(body);
            expect(body.result.email).toBe(`${SEED_USERNAME}@example.com`);
          }),
        timeout,
      );
    });

    describe("ListUsers", () => {
      test.provider(
        "lists the instance's users",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-users");
            expectOk(body);
            expect(body.result.users.map((user: { username: string }) => user.username)).toContain(
              SEED_USERNAME,
            );
          }),
        timeout,
      );
    });

    describe("UpdateUser", () => {
      test.provider(
        "changes a user, which shows up out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, instanceId } = yield* stack;
            const body = yield* call("/update-user", {
              username: "alchemy-bindings-created",
              name: "Changed by a binding",
            });
            expectOk(body);
            const fetched = yield* git.getUser({
              projectId: projectId!,
              instanceId: instanceId!,
              username: "alchemy-bindings-created",
            });
            expect(fetched.name).toBe("Changed by a binding");
          }),
        timeout,
      );
    });

    describe("DeleteUser", () => {
      test.provider(
        "deletes a user, which is gone out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, instanceId } = yield* stack;
            const body = yield* call("/delete-user", { username: "alchemy-bindings-created" });
            expectOk(body);
            const error = yield* git
              .getUser({
                projectId: projectId!,
                instanceId: instanceId!,
                username: "alchemy-bindings-created",
              })
              .pipe(Effect.flip);
            expect(error._tag).toBe("NotFound");
          }),
        timeout,
      );
    });

    describe("GetAuthenticationSource", () => {
      test.provider(
        "reads a source, with no secret in the answer",
        (_stack) =>
          Effect.gen(function* () {
            const { authenticationId } = yield* stack;
            const body = yield* call("/get-authentication-source", { id: authenticationId! });
            expectOk(body);
            expect(body.result.name).toBe("alchemy-bindings-sso");
            expect(JSON.stringify(body.result)).not.toContain("not-a-real-client-secret");
          }),
        timeout,
      );
    });

    describe("ListAuthenticationSources", () => {
      test.provider(
        "lists the instance's sources",
        (_stack) =>
          Effect.gen(function* () {
            const { authenticationId } = yield* stack;
            const body = yield* call("/list-authentication-sources");
            expectOk(body);
            expect(body.result.authentication.map((source: { id: string }) => source.id)).toEqual([
              authenticationId,
            ]);
          }),
        timeout,
      );
    });

    describe("ListFlavors", () => {
      test.provider(
        "lists the plans, the one Alchemy defaults to among them",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-flavors");
            expectOk(body);
            expect(body.result.flavors.map((flavor: { id: string }) => flavor.id)).toContain(
              "git-10",
            );
          }),
        timeout,
      );
    });

    describe("ListRunnerFamilies", () => {
      test.provider(
        "lists at least one job family, with its limits",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-runner-families");
            expectOk(body);
            expect(body.result.items.length).toBeGreaterThan(0);
            expect(body.result.items[0].name).toEqual(expect.any(String));
            expect(body.result.items[0].cpu).toEqual(expect.any(String));
          }),
        timeout,
      );
    });

    describe("ListRunnerRuntimes", () => {
      test.provider(
        "lists the runtimes, the label the fixture's runner uses among them",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-runner-runtimes");
            expectOk(body);
            expect(body.result.items.map((runtime: { label: string }) => runtime.label)).toContain(
              "stackit-docker",
            );
          }),
        timeout,
      );
    });

    describe("GetRepository", () => {
      test.provider(
        "reads the bound repository through Forgejo, with the login in the host's env",
        (_stack) =>
          Effect.gen(function* () {
            const { repositoryId } = yield* stack;
            const body = yield* call("/get-repository");
            expectOk(body);
            expect(body.result.id).toBe(repositoryId);
            expect(body.result.name).toBe("alchemy-bindings-repo");
            expect(body.result.owner.login).toBe(SEED_USERNAME);
          }),
        timeout,
      );
    });
  },
);
