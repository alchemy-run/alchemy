import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as automation from "@distilled.cloud/stackit/automation";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import AutomationBindingsWorker, {
  Covered,
  OnDemand,
  RECOVERY_POINT_SELECTOR,
} from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitAutomationBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* AutomationBindingsWorker;
    const onDemand = yield* OnDemand;
    const covered = yield* Covered;
    return {
      url: worker.url.as<string>(),
      automationId: onDemand.automationId,
      automationName: onDemand.name,
      templateId: onDemand.templateId,
      projectId: onDemand.projectId,
      region: onDemand.region,
      volumeId: covered.volumeId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// One 1 GB volume and the snapshots of its runs, billed per started hour: under EUR 0.01 per run.
// Runs of one automation go one after another.
describe.sequential(
  "STACKIT Automation bindings on a Cloudflare Worker",
  { tags: [...stackitTags("automation", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real failure
    // shows its STACKIT error.
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

    const target = Effect.gen(function* () {
      const { projectId, region, automationId } = yield* stack;
      return { projectId: projectId!, region: region!, automationId: automationId! };
    });

    /** A run's end, within STACKIT's budget for a volume this small. */
    const settled = (executionId: string) =>
      Effect.gen(function* () {
        const scope = yield* target;
        return yield* automation.getVolumeExecution({ ...scope, executionId }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: ({ status }) =>
              status === "COMPLETED" || status === "FAILED" || status === "TERMINATED",
            times: 36,
          }),
        );
      });

    /** The recovery points of this suite's runs. */
    const recoveryPoints = Effect.gen(function* () {
      const { projectId, region } = yield* target;
      const { items } = yield* iaas.listSnapshotsInProject({
        projectId,
        region,
        label_selector: RECOVERY_POINT_SELECTOR,
      });
      return items;
    });

    /** A run makes snapshots no resource owns, and they hold the volume: delete them. */
    const deleteRecoveryPoints = Effect.gen(function* () {
      const { projectId, region } = yield* target;
      for (const snapshot of yield* recoveryPoints) {
        yield* iaas
          .deleteSnapshot({ projectId, region, snapshotId: snapshot.id! })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    });

    /** An execution of the deployed automation, made out of band, and finished. */
    const anExecution = Effect.gen(function* () {
      const scope = yield* target;
      const { id } = yield* automation.createVolumeExecution(scope);
      yield* settled(id);
      return id;
    }).pipe(Effect.ensuring(deleteRecoveryPoints.pipe(Effect.ignore)));

    describe("GetVolumeAutomation", () => {
      test.provider(
        "reads the bound automation",
        (_stack) =>
          Effect.gen(function* () {
            const { automationId, automationName } = yield* stack;
            const body = yield* call("/get-automation");
            expectOk(body);
            expect(body.result.id).toBe(automationId);
            expect(body.result.name).toBe(automationName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListVolumeAutomations", () => {
      test.provider(
        "lists the deployed automation",
        (_stack) =>
          Effect.gen(function* () {
            const { automationId } = yield* stack;
            const body = yield* call("/list-automations");
            expectOk(body);
            const ids = body.result.items.map((item: { id: string }) => item.id);
            expect(ids).toContain(automationId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CreateVolumeExecution", () => {
      test.provider(
        "runs the automation now and takes a recovery point",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-execution");
            expectOk(body);
            const { status } = yield* settled(body.result.id);
            expect(status).toBe("COMPLETED");
            const { volumeId } = yield* stack;
            const taken = yield* recoveryPoints;
            expect(taken.map((snapshot) => snapshot.volumeId)).toContain(volumeId);
          }).pipe(Effect.ensuring(deleteRecoveryPoints.pipe(Effect.ignore))),
        { timeout: 300_000 },
      );
    });

    describe("GetVolumeExecution", () => {
      test.provider(
        "reads a run of the automation",
        (_stack) =>
          Effect.gen(function* () {
            const executionId = yield* anExecution;
            const body = yield* call("/get-execution", { id: executionId });
            expectOk(body);
            expect(body.result.id).toBe(executionId);
            expect(body.result.status).toBe("COMPLETED");
          }),
        { timeout: 300_000 },
      );
    });

    describe("ListVolumeExecutions", () => {
      test.provider(
        "lists the runs of the automation",
        (_stack) =>
          Effect.gen(function* () {
            const executionId = yield* anExecution;
            const body = yield* call("/list-executions");
            expectOk(body);
            const ids = body.result.items.map((item: { id: string }) => item.id);
            expect(ids).toContain(executionId);
          }),
        { timeout: 300_000 },
      );
    });

    describe("GetVolumeTemplate", () => {
      test.provider(
        "reads the automation's template",
        (_stack) =>
          Effect.gen(function* () {
            const { templateId } = yield* stack;
            const body = yield* call("/get-template", { id: templateId! });
            expectOk(body);
            expect(body.result.id).toBe(templateId);
            expect(body.result.input.kind).toBe("VolumeRecoveryPointManagement");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListVolumeTemplates", () => {
      test.provider(
        "lists the automation's template",
        (_stack) =>
          Effect.gen(function* () {
            const { templateId } = yield* stack;
            const body = yield* call("/list-templates");
            expectOk(body);
            const ids = body.result.items.map((item: { id: string }) => item.id);
            expect(ids).toContain(templateId);
          }),
        { timeout: 240_000 },
      );
    });
  },
);
