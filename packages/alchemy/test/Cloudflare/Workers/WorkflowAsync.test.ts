import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { WorkflowResource } from "@/Cloudflare/Workflows/Workflow";
import { generateWorkflowName } from "@/Cloudflare/Workflows/WorkflowName";
import { sha256 } from "@/Util/sha256";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ColdEffectWorker, {
  COLD_EFFECT_WORKFLOW_NAME,
} from "./fixtures/workflow-async/effect-worker.ts";
import Stack from "./fixtures/workflow-async/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(
  deploy(Stack).pipe(
    // Let the freshly-deployed worker (and its Workflow binding) settle before
    // the first run so a step doesn't error mid-propagation.
    Effect.tap(Effect.sleep("5 seconds")),
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface WorkflowStatus {
  status: string;
  output?: { greeting: string; workflowName?: string };
  error?: { message?: string } | null;
}

// Start a fresh workflow instance and poll until it reaches a terminal state.
// A transient `errored` during edge/binding propagation fails this effect so
// the caller can retry with a brand-new instance.
const runWorkflowToCompletion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    // Cloudflare's edge takes a few seconds to start serving a fresh
    // workers.dev URL, so retry until it returns 200 (a fresh URL also
    // returns 404 transiently, which is not an HTTP error so Effect.retry
    // does not catch it unless we explicitly fail on non-200).
    const { instanceId } = yield* client
      .post(`${url}/workflow/start/world`)
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json.pipe(
                Effect.flatMap((body) => {
                  const instanceId = (body as { instanceId?: unknown })
                    .instanceId;
                  return typeof instanceId === "string"
                    ? Effect.succeed({ instanceId })
                    : Effect.fail(new Error("Worker returned no workflow id"));
                }),
              )
            : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
        ),
        Effect.retry({
          // Cap the exponential at 3s — uncapped, 15 retries grow past 30s of
          // sleep after only six attempts and blow the test timeout.
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("3 seconds"),
          ]),
          times: 15,
        }),
      );
    expect(instanceId).toBeTypeOf("string");

    const lastStatus = yield* client
      .get(`${url}/workflow/status/${instanceId}`)
      .pipe(
        // The status endpoint transiently returns a 500 (HTML error page, not
        // JSON) while the freshly-deployed worker's Workflow binding is still
        // propagating. Only decode JSON on a 200; treat any other status as a
        // non-terminal "pending" so the poll keeps swinging instead of dying
        // on a JSON decode error.
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json.pipe(
                Effect.map((json) => json as unknown as WorkflowStatus),
              )
            : Effect.succeed({ status: "pending" } as WorkflowStatus),
        ),
        Effect.repeat({
          // Under full-suite load a fresh workflow instance can sit in
          // `pending`/`queued` well past 24s before its first step runs;
          // give each attempt ~60s before handing back to the outer retry.
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s.status === "complete" || s.status === "errored",
          times: 30,
        }),
      );

    // Surface a non-complete terminal state as a failure so the outer retry
    // can take another swing (a fresh worker occasionally errors a step while
    // its bindings are still propagating).
    if (lastStatus.status !== "complete") {
      return yield* Effect.fail(
        new Error(
          `workflow ${lastStatus.status}: ${JSON.stringify(lastStatus.error)}`,
        ),
      );
    }
    return lastStatus;
  });

test(
  "async worker can run a class-based workflow bound via env",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = out.url;
    expect(url).toBeTypeOf("string");

    const lastStatus = yield* runWorkflowToCompletion(url).pipe(
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
    );

    expect(lastStatus.status).toBe("complete");
    expect(lastStatus.error).toBeFalsy();
    expect(lastStatus.output?.greeting).toBe("Hello, world!");
  }).pipe(logLevel),
  // Budget covers the full retry envelope: up to 3 attempts, each with a
  // capped start-retry (~30s worst case) + status polling (30 × 2s).
  { timeout: 300_000 },
);

// ---------------------------------------------------------------------------
// Cross-script binding: a consumer Worker binds a Workflow hosted by another
// Worker script via `scriptName`. The host owns the workflow (props-only form
// with no `scriptName` → drives `putWorkflow`); the consumer's binding is a
// reference only. Inline `script` keeps both workers in this one file.
// ---------------------------------------------------------------------------

// Host hosts the WorkflowEntrypoint class AND drives a workflow instance.
const hostWorkflowScript = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class MyWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const greeting = await step.do("greet", async () => \`Hello, \${event.payload.value}!\`);
    return await step.do("finalize", async () => ({ greeting }));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
`;

// Consumer has no class — it only references the host's workflow.
const consumerWorkflowScript = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }
    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
`;

test.provider(
  "async worker workflow binding accepts scriptName (cross-script)",
  (scratch) =>
    Effect.gen(function* () {
      // Deploy the host first so its workflow exists (putWorkflow) before the
      // consumer references it by scriptName.
      yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            host: yield* Cloudflare.Worker("host-workflow-worker", {
              script: hostWorkflowScript,
              env: {
                MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow"),
              },
            }),
          };
        }),
      );

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const host = yield* Cloudflare.Worker("host-workflow-worker", {
            script: hostWorkflowScript,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow"),
            },
          });
          const consumer = yield* Cloudflare.Worker(
            "consumer-workflow-worker",
            {
              script: consumerWorkflowScript,
              env: {
                MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
                  scriptName: host.workerName,
                }),
              },
            },
          );
          return { consumer, host };
        }),
      );

      // Start + complete a workflow instance through the CONSUMER's binding,
      // exercising both `create` and `get` across the cross-script reference.
      const lastStatus = yield* runWorkflowToCompletion(
        deployed.consumer.url!,
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
      );

      expect(lastStatus.status).toBe("complete");
      expect(lastStatus.error).toBeFalsy();
      expect(lastStatus.output?.greeting).toBe("Hello, world!");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// Per-workflow limits: deploy a locally-hosted workflow declared with a step
// limit, then read it back out-of-band from the versions API (the only read
// that surfaces `limits`) to confirm it was applied.
// ---------------------------------------------------------------------------

const limitsWorkflowScript = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class LimitsWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("noop", async () => "ok");
  }
}
export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

// Physical workflow names are derived from the host Worker name and class, so
// read the name off the deployed binding rather than assuming the class name.
const readWorkflowName = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    const binding = (settings.bindings ?? []).find(
      (b): b is Extract<typeof b, { type: "workflow" }> =>
        b.type === "workflow",
    );
    return binding === undefined
      ? yield* Effect.fail(new Error(`no workflow binding on '${scriptName}'`))
      : binding.workflowName;
  });

// Read the applied step limit out-of-band via the versions API, retrying until
// it propagates (bounded, so a missing limit fails fast).
const waitForAppliedStepLimit = (workflowName: string, expected: number) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const versions = yield* workflows.listVersions
      .items({ accountId, workflowName })
      .pipe(Stream.runCollect);
    return Array.from(versions)
      .map((v) => v.limits?.steps ?? undefined)
      .find((steps) => steps !== undefined);
  }).pipe(
    Effect.flatMap((steps) =>
      steps === expected
        ? Effect.succeed(steps)
        : Effect.fail(new Error(`steps limit not applied yet: ${steps}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

test.provider(
  "async worker workflow binding applies a per-workflow step limit",
  (scratch) =>
    Effect.gen(function* () {
      const steps = 100;

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("limits-workflow-worker", {
              script: limitsWorkflowScript,
              env: {
                LIMITS_WORKFLOW: Cloudflare.Workflow("LimitsWorkflow", {
                  limits: { steps },
                }),
              },
            }),
          };
        }),
      );

      const workflowName = yield* readWorkflowName(deployed.worker.workerName);
      const applied = yield* waitForAppliedStepLimit(workflowName, steps);
      expect(applied).toBe(steps);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// #1473 regression: native Workflow schedules on the async (props-only)
// reference form, driven by a file-based fixture (`main`, not inline
// `script`). Yearly crons so the test never waits for a fire; create →
// update → clear is asserted out-of-band via getWorkflow.
// ---------------------------------------------------------------------------

const scheduledWorkflowMain = `${import.meta.dirname}/fixtures/workflow-schedules/async-worker.ts`;

const waitForAppliedSchedules = (workflowName: string, expected: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const workflow = yield* workflows.getWorkflow({
      accountId,
      workflowName,
    });
    return (workflow.schedules ?? []).map((s) => s.cron);
  }).pipe(
    Effect.flatMap((crons) =>
      crons.length === expected.length &&
      crons.every((cron, index) => cron === expected[index])
        ? Effect.succeed(crons)
        : Effect.fail(
            new Error(`schedules not applied yet: ${JSON.stringify(crons)}`),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

test.provider(
  "async worker workflow binding applies native cron schedules",
  (scratch) =>
    Effect.gen(function* () {
      const yearly = "0 0 1 1 *";
      const other = "0 0 2 1 *";

      const deployWith = (schedules: string[]) =>
        scratch.deploy(
          Effect.gen(function* () {
            return {
              worker: yield* Cloudflare.Worker("scheduled-workflow-worker", {
                main: scheduledWorkflowMain,
                env: {
                  HOURLY: Cloudflare.Workflow("HourlyWorkflow", {
                    className: "HourlyWorkflow",
                    schedules,
                  }),
                },
              }),
            };
          }),
        );

      const created = yield* deployWith([yearly]);
      const workflowName = yield* readWorkflowName(created.worker.workerName);
      expect(yield* waitForAppliedSchedules(workflowName, [yearly])).toEqual([
        yearly,
      ]);

      yield* deployWith([other]);
      expect(yield* waitForAppliedSchedules(workflowName, [other])).toEqual([
        other,
      ]);

      yield* deployWith([]);
      expect(yield* waitForAppliedSchedules(workflowName, [])).toEqual([]);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

const namedWorkflowMain = `${import.meta.dirname}/fixtures/workflow-async/worker.ts`;
const physicalName = (scratch: Test.ScratchStack) =>
  sha256(`${scratch.name}:${scratch.stage}`).pipe(
    Effect.map((hash) => `alchemy-workflow-${hash.slice(0, 16)}`),
  );
const expectWorkflowGone = (accountId: string, workflowName: string) =>
  workflows.getWorkflow({ accountId, workflowName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const namedHost = (workflowName?: string, schedules?: string[]) =>
  Cloudflare.Worker("NamedHost", {
    main: namedWorkflowMain,
    env: {
      MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
        workflowName,
        schedules,
      }),
    },
  });

test.provider(
  "physical names preserve defaults, replace on rename, and retain schedules",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const explicit = yield* physicalName(scratch);
      const original = yield* scratch.deploy(namedHost());
      const generated = yield* readWorkflowName(original.workerName);
      expect(generated).toBe(
        yield* generateWorkflowName(original.workerName, "MyWorkflow"),
      );
      const first = yield* workflows.getWorkflow({
        accountId,
        workflowName: generated,
      });

      yield* scratch.deploy(namedHost(generated));
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName: generated }))
          .id,
      ).toBe(first.id);

      const renamed = yield* scratch.deploy(namedHost(explicit, ["0 0 1 1 *"]));
      const replacement = yield* workflows.getWorkflow({
        accountId,
        workflowName: explicit,
      });
      expect(replacement.id).not.toBe(first.id);
      expect(yield* readWorkflowName(renamed.workerName)).toBe(explicit);
      yield* expectWorkflowGone(accountId, generated);
      expect(yield* waitForAppliedSchedules(explicit, ["0 0 1 1 *"])).toEqual([
        "0 0 1 1 *",
      ]);

      const preserved = yield* scratch.deploy(namedHost());
      expect(yield* readWorkflowName(preserved.workerName)).toBe(explicit);
      const observed = yield* workflows.getWorkflow({
        accountId,
        workflowName: explicit,
      });
      expect(observed.id).toBe(replacement.id);
      expect(observed.schedules?.map((schedule) => schedule.cron)).toEqual([
        "0 0 1 1 *",
      ]);
      const terminal = yield* runWorkflowToCompletion(preserved.url!).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
      );
      expect(terminal.output?.workflowName).toBe(explicit);

      yield* scratch.deploy(namedHost(undefined, []));
      expect(yield* waitForAppliedSchedules(explicit, [])).toEqual([]);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, explicit);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "physical names require adoption and preserve adopted identity and schedules",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName = yield* physicalName(scratch);
      const host = Cloudflare.Worker("AdoptionHost", {
        main: namedWorkflowMain,
      });
      const deployed = yield* scratch.deploy(host);
      yield* expectWorkflowGone(accountId, workflowName);
      const foreign = yield* workflows.putWorkflow({
        accountId,
        workflowName,
        scriptName: deployed.workerName,
        className: "MyWorkflow",
        schedules: [{ cron: "0 0 1 1 *" }],
      });
      yield* Effect.addFinalizer(() =>
        workflows.deleteWorkflow({ accountId, workflowName }).pipe(
          Effect.catchTag("WorkflowNotFound", () => Effect.void),
          Effect.orDie,
        ),
      );
      const definition = (adopting: boolean, schedules?: string[]) =>
        Effect.gen(function* () {
          const worker = yield* host;
          return yield* WorkflowResource("Adopted", {
            workflowName,
            className: "MyWorkflow",
            scriptName: worker.workerName,
            schedules,
          }).pipe(adopt(adopting));
        });
      const denied = yield* scratch.plan(definition(false)).pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied))
        expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName })).id,
      ).toBe(foreign.id);

      const adopted = yield* scratch.deploy(definition(true));
      expect(adopted.workflowName).toBe(workflowName);
      expect(adopted.workflowId).toBe(foreign.id);
      expect(adopted.schedules).toEqual(["0 0 1 1 *"]);
      const updated = yield* scratch.deploy(definition(false, []));
      expect(updated.workflowId).toBe(foreign.id);
      expect(yield* waitForAppliedSchedules(workflowName, [])).toEqual([]);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, workflowName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "physical names refuse occupied rename targets even with adoption enabled",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const originalName = yield* physicalName(scratch);
      const occupiedName = `${originalName}-occupied`;
      const occupiedHost = Cloudflare.Worker("OccupiedHost", {
        main: namedWorkflowMain,
        env: {
          MY_WORKFLOW: Cloudflare.Workflow("OccupiedWorkflow", {
            className: "MyWorkflow",
            workflowName: occupiedName,
            schedules: ["0 0 1 1 *"],
          }),
        },
      });
      const definition = (name: string) =>
        Effect.gen(function* () {
          const host = yield* namedHost(name);
          const occupied = yield* occupiedHost;
          return { host, occupied };
        });
      yield* scratch.deploy(definition(originalName));
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName: originalName,
      });
      const occupied = yield* workflows.getWorkflow({
        accountId,
        workflowName: occupiedName,
      });
      const denied = yield* scratch
        .deploy(definition(occupiedName).pipe(adopt(true)))
        .pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied))
        expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
      const untouched = yield* workflows.getWorkflow({
        accountId,
        workflowName: occupiedName,
      });
      expect(untouched.id).toBe(occupied.id);
      expect(untouched.scriptName).toBe(occupied.scriptName);
      expect(untouched.schedules).toEqual(occupied.schedules);
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: originalName,
        })).id,
      ).toBe(original.id);
      // Removing the rejected source must not delete the occupied target.
      yield* scratch.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Worker("NamedHost", { main: namedWorkflowMain });
          yield* occupiedHost;
        }),
      );
      yield* expectWorkflowGone(accountId, originalName);
      expect(
        (yield* workflows.getWorkflow({
          accountId,
          workflowName: occupiedName,
        })).id,
      ).toBe(occupied.id);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, originalName);
      yield* expectWorkflowGone(accountId, occupiedName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "physical names link cross-script consumers without owning the host Workflow",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName = yield* physicalName(scratch);
      const host = namedHost(workflowName);
      yield* scratch.deploy(host);
      const original = yield* workflows.getWorkflow({
        accountId,
        workflowName,
      });
      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const worker = yield* host;
          const consumer = yield* Cloudflare.Worker("NamedConsumer", {
            main: namedWorkflowMain,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("ForeignWorkflow", {
                className: "MyWorkflow",
                scriptName: worker.workerName,
                workflowName,
              }),
            },
          });
          return { worker, consumer };
        }),
      );
      expect(yield* readWorkflowName(deployed.consumer.workerName)).toBe(
        workflowName,
      );
      const terminal = yield* runWorkflowToCompletion(
        deployed.consumer.url!,
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
      );
      expect(terminal.output?.workflowName).toBe(workflowName);
      yield* scratch.deploy(host);
      expect(
        (yield* workflows.getWorkflow({ accountId, workflowName })).id,
      ).toBe(original.id);
      yield* scratch.destroy();
      yield* expectWorkflowGone(accountId, workflowName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

for (const dev of [false, true]) {
  const { test: hostTest } = Test.make({
    providers: Cloudflare.providers(),
    dev,
  });

  hostTest.provider(
    `binding-only host changes update dependent scriptName in the same deploy (dev: ${dev})`,
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const workflowName = yield* physicalName(scratch);
        const definition = (destination: "A" | "B") =>
          Effect.gen(function* () {
            const a = yield* Cloudflare.Worker("HostA", {
              main: namedWorkflowMain,
            });
            const b = yield* Cloudflare.Worker("HostB", {
              main: namedWorkflowMain,
            });
            const host = destination === "A" ? a : b;
            const workflow = yield* WorkflowResource("MovedWorkflow", {
              workflowName,
              className: "MyWorkflow",
              schedules: ["0 0 1 1 *"],
            });
            yield* workflow.bind`host`({ scriptName: host.workerName });
            const consumer = yield* Cloudflare.Worker("HostConsumer", {
              main: namedWorkflowMain,
              env: { WORKFLOW_SCRIPT_NAME: workflow.scriptName },
            });
            return { host, workflow, consumer };
          });
        const client = yield* HttpClient.HttpClient;
        const expectScript = (url: string, scriptName: string) =>
          client.get(`${url}/workflow/script-name`).pipe(
            Effect.flatMap((response) => response.text),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (name) => name === scriptName,
              times: 8,
            }),
            Effect.tap((name) =>
              Effect.sync(() => expect(name).toBe(scriptName)),
            ),
          );
        const original = yield* scratch.deploy(definition("A"));
        yield* expectScript(original.consumer.url!, original.host.workerName);
        if (dev) {
          expect(original.workflow.workflowId).toMatch(/^dev:/);
          expect(original.consumer.url).toMatch(/^http:\/\/localhost:/);
        }

        const moved = yield* scratch.deploy(definition("B"));
        expect(moved.host.workerName).not.toBe(original.host.workerName);
        expect(moved.workflow.workflowId).toBe(original.workflow.workflowId);
        expect(moved.workflow.scriptName).toBe(moved.host.workerName);
        yield* expectScript(moved.consumer.url!, moved.host.workerName);
        if (!dev) {
          const observed = yield* workflows.getWorkflow({
            accountId: moved.workflow.accountId,
            workflowName,
          });
          expect(observed.id).toBe(original.workflow.workflowId);
          expect(observed.scriptName).toBe(moved.host.workerName);
          expect(observed.schedules?.map((schedule) => schedule.cron)).toEqual([
            "0 0 1 1 *",
          ]);
        }
        yield* scratch.destroy();
        if (!dev) {
          yield* expectWorkflowGone(moved.workflow.accountId, workflowName);
        }
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
}

for (const api of ["async", "Effect"]) {
  test.provider(
    `public ${api} Workflow cold adoption with a new destination Worker`,
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        const workflowName =
          api === "async"
            ? yield* physicalName(scratch)
            : COLD_EFFECT_WORKFLOW_NAME;
        const source = Cloudflare.Worker("ColdAdoptionSource", {
          main: namedWorkflowMain,
        });
        const seededHost = yield* scratch.deploy(source);
        yield* expectWorkflowGone(accountId, workflowName);
        const existing = yield* workflows.putWorkflow({
          accountId,
          workflowName,
          scriptName: seededHost.workerName,
          className: "MyWorkflow",
          schedules: [{ cron: "0 0 1 1 *" }],
        });
        yield* Effect.addFinalizer(() =>
          workflows.deleteWorkflow({ accountId, workflowName }).pipe(
            Effect.catchTag("WorkflowNotFound", () => Effect.void),
            Effect.orDie,
          ),
        );
        const definition = Effect.gen(function* () {
          yield* source;
          if (api === "async") return yield* namedHost(workflowName);
          return yield* ColdEffectWorker;
        });
        const denied = yield* scratch
          .plan(definition.pipe(adopt(false)))
          .pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        if (Exit.isFailure(denied))
          expect(Cause.pretty(denied.cause)).toContain("OwnedBySomeoneElse");
        const untouched = yield* workflows.getWorkflow({
          accountId,
          workflowName,
        });
        expect(untouched.id).toBe(existing.id);
        expect(untouched.scriptName).toBe(seededHost.workerName);
        expect(untouched.schedules?.map((schedule) => schedule.cron)).toEqual([
          "0 0 1 1 *",
        ]);
        const destination = yield* scratch.deploy(definition.pipe(adopt(true)));
        const adopted = yield* workflows.getWorkflow({
          accountId,
          workflowName,
        });
        expect(adopted.id).toBe(existing.id);
        expect(adopted.scriptName).toBe(destination.workerName);
        expect(adopted.schedules?.map((schedule) => schedule.cron)).toEqual([
          "0 0 1 1 *",
        ]);
        const terminal = yield* runWorkflowToCompletion(destination.url!).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 2 }),
        );
        expect(terminal.output?.greeting).toBe("Hello, world!");
        expect(terminal.output?.workflowName).toBe(workflowName);
        yield* scratch.destroy();
        yield* expectWorkflowGone(accountId, workflowName);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
}
