import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { recoveryPointTemplateId } from "../templates.ts";

/** Labels of the covered volume and of the recovery points, which a test deletes by label. */
export const VOLUME_LABEL = "alchemy-automation-bindings";
export const RECOVERY_POINT_SELECTOR = `${VOLUME_LABEL}=recovery-point`;

/** Resolved at plan: templates are STACKIT's own and differ per region. */
const templateId = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    return yield* recoveryPointTemplateId({ projectId, region });
  }).pipe(Effect.orDie),
);

/** The volume the automation covers, so a run has something to take a recovery point of. */
export const Covered = Stackit.IaaS.Volume("AutomationBindingsVolume", {
  size: 1,
  labels: { [VOLUME_LABEL]: "covered" },
});

export const OnDemand = Stackit.Automation.VolumeAutomation("AutomationBindingsAutomation", {
  templateId,
  input: {
    volumeLabelSelector: `${VOLUME_LABEL}=covered`,
    recoveryPointLabels: { [VOLUME_LABEL]: "recovery-point" },
    snapshotRetentionPolicy: { kind: "count", value: 1 },
  },
});

/**
 * A Cloudflare Worker with every Automation binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class AutomationBindingsWorker extends Cloudflare.Worker<AutomationBindingsWorker>()(
  "StackitAutomationBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const onDemand = yield* OnDemand;
    const getVolumeAutomation = yield* Stackit.Automation.GetVolumeAutomation(onDemand);
    const listVolumeAutomations = yield* Stackit.Automation.ListVolumeAutomations(onDemand);
    const createVolumeExecution = yield* Stackit.Automation.CreateVolumeExecution(onDemand);
    const getVolumeExecution = yield* Stackit.Automation.GetVolumeExecution(onDemand);
    const listVolumeExecutions = yield* Stackit.Automation.ListVolumeExecutions(onDemand);
    const getVolumeTemplate = yield* Stackit.Automation.GetVolumeTemplate(onDemand);
    const listVolumeTemplates = yield* Stackit.Automation.ListVolumeTemplates(onDemand);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-automation":
            return yield* respond(getVolumeAutomation());
          case "/list-automations":
            return yield* respond(listVolumeAutomations({ pageSize: 100 }));
          case "/create-execution":
            return yield* respond(createVolumeExecution());
          case "/get-execution":
            return yield* respond(getVolumeExecution({ executionId: param("id") }));
          case "/list-executions":
            return yield* respond(listVolumeExecutions({ pageSize: 100 }));
          case "/get-template":
            return yield* respond(getVolumeTemplate({ templateId: param("id") }));
          case "/list-templates":
            return yield* respond(listVolumeTemplates({ pageSize: 100 }));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Automation.GetVolumeAutomationHttp,
        Stackit.Automation.ListVolumeAutomationsHttp,
        Stackit.Automation.CreateVolumeExecutionHttp,
        Stackit.Automation.GetVolumeExecutionHttp,
        Stackit.Automation.ListVolumeExecutionsHttp,
        Stackit.Automation.GetVolumeTemplateHttp,
        Stackit.Automation.ListVolumeTemplatesHttp,
      ),
    ),
  ),
) {}
