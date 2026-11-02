import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow } from "../IaaS/compute.ts";
import RunCommandTemplatesWorker from "./fixtures/templates-worker.ts";
import RunCommandBindingsWorker, { Web } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const TemplatesStack = Alchemy.Stack(
  "StackitRunCommandTemplatesStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* RunCommandTemplatesWorker;
    return { url: worker.url.as<string>() };
  }),
);

const Stack = Alchemy.Stack(
  "StackitRunCommandBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* RunCommandBindingsWorker;
    const server = yield* Web;
    return {
      url: worker.url.as<string>(),
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// A fresh workers.dev URL, the created key and the account's new memberships take a
// while to propagate: retry until the route answers `ok`, then report the last answer
// so a real failure shows its STACKIT error.
const callAt = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

describe(
  "STACKIT Run Command bindings without a server",
  { tags: [...stackitTags("runcommand", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(TemplatesStack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TemplatesStack), { timeout: 300_000 });

    describe("ListCommandTemplates", () => {
      test.provider(
        "lists the Linux templates, RunShellScript among them",
        (_stack) =>
          Effect.gen(function* () {
            const { url } = yield* stack;
            const body = yield* callAt(url);
            expectOk(body);
            const names = (body.result.items as { name: string }[]).map((item) => item.name);
            expect(names).toContain("RunShellScript");
          }),
        { timeout: 300_000 },
      );
    });
  },
);

// The server is billed per hour (a g1.1 with a 10 GB boot volume, one started hour:
// about EUR 0.05 per run): gated behind STACKIT_TEST_SLOW, like the suites of the
// same resource. The steps act on one server, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT Run Command bindings",
  { tags: [...stackitTags("runcommand", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* callAt(`${url}${route}`);
      });

    /** The id of a command the Worker created, which `CreateCommand` covers. */
    const createCommand = (script: string) =>
      Effect.gen(function* () {
        const body = yield* call(`/create?script=${encodeURIComponent(script)}`);
        expectOk(body);
        expect(typeof body.result.id).toBe("number");
        return String(body.result.id);
      });

    describe("CreateCommand", () => {
      test.provider(
        "runs a script on the bound server, confirmed out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, serverId } = yield* stack;
            const commandId = yield* createCommand("echo created-by-binding");
            const details = yield* runCommand
              .getCommand({
                projectId: projectId!,
                region: region!,
                serverId: serverId!,
                commandId,
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (command) => command.status === "completed" || command.status === "failed",
                  times: 60,
                }),
              );
            expect({ status: details.status, exitCode: details.exitCode }).toEqual({
              status: "completed",
              exitCode: 0,
            });
          }),
        { timeout: 600_000 },
      );
    });

    describe("GetCommand", () => {
      test.provider(
        "reads a finished command's output",
        (_stack) =>
          Effect.gen(function* () {
            const commandId = yield* createCommand("echo read-by-binding");
            const body = yield* call(`/get?id=${commandId}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (answer) =>
                  answer.result?.status === "completed" || answer.result?.status === "failed",
                times: 60,
              }),
            );
            expectOk(body);
            expect(body.result.status).toBe("completed");
            expect(body.result.output).toContain("read-by-binding");
          }),
        { timeout: 600_000 },
      );
    });

    describe("ListCommands", () => {
      test.provider(
        "lists the commands the server has run",
        (_stack) =>
          Effect.gen(function* () {
            const commandId = yield* createCommand("true");
            const body = yield* call("/list");
            expectOk(body);
            const ids = (body.result.items as { id: number }[]).map((item) => String(item.id));
            expect(ids).toContain(commandId);
          }),
        { timeout: 600_000 },
      );
    });

    describe("GetCommandTemplate", () => {
      test.provider(
        "reads the shell template",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/template");
            expectOk(body);
            expect(body.result.name).toBe("RunShellScript");
          }),
        { timeout: 300_000 },
      );
    });
  },
);
