import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import ExternalHostWorker, { Probe } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitExternalHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ExternalHostWorker;
    const project = yield* Probe;
    return { url: worker.url.as<string>(), projectId: project.projectId };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// STACKIT requires a user among a new project's members; see the fixture.
const owner = process.env.STACKIT_TEST_PROJECT_OWNER;

const PERMISSION = "resource-manager.project.get";

describe.skipIf(!owner)(
  "STACKIT bindings on a Cloudflare Worker",
  { tags: [...stackitTags("externalhost"), "provider:cloudflare"] },
  () => {
    // Creating and deleting a project takes minutes.
    const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

    // A fresh workers.dev URL, the created key and the account's new membership
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

    // `test.provider` supplies the STACKIT credentials for the out-of-band reads.
    test.provider(
      "GetProject reads the bound project with the created key",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* call("/project");
          expectOk(body);

          const { projectId } = yield* stack;
          expect(body.result.projectId).toBe(projectId);

          const project = yield* resourceManager.getProject({ id: projectId! });
          expect(body.result.containerId).toBe(project.containerId);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "the created account holds only a custom role with the one permission",
      (_stack) =>
        Effect.gen(function* () {
          const { projectId } = yield* stack;
          const scope = { resourceType: "project", resourceId: projectId! };

          const { roles } = yield* authorization.listRoles(scope);
          const custom = roles.find(
            (role) =>
              role.id !== undefined &&
              role.permissions.length === 1 &&
              role.permissions[0]!.name === PERMISSION,
          );
          expect(custom?.name).toBeTruthy();

          const { members } = yield* authorization.listMembers(scope);
          const subject = members.find((member) => member.role === custom!.name)?.subject;
          expect(subject).toMatch(/@sa\.stackit\.cloud$/);
          expect(
            members.filter((member) => member.subject === subject).map((member) => member.role),
          ).toEqual([custom!.name]);
        }),
      { timeout: 120_000 },
    );
  },
);
