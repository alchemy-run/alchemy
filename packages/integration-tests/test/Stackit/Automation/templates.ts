import * as automation from "@distilled.cloud/stackit/automation";
import * as serviceEnablement from "@distilled.cloud/stackit/service_enablement";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/** A recurrence far enough ahead that no test run ever fires. */
export const RARELY = "DTSTART;TZID=UTC:20400101T023000 RRULE:FREQ=DAILY;INTERVAL=1";
export const RARELY_WEEKLY = "DTSTART;TZID=UTC:20400101T033000 RRULE:FREQ=WEEKLY;INTERVAL=1";

export class NoRecoveryPointTemplate extends Data.TaggedError("NoRecoveryPointTemplate")<{
  readonly message: string;
}> {}

/**
 * Id of the system template of kind `VolumeRecoveryPointManagement`. Templates are STACKIT's own
 * and can't be created, so a suite has to find one, and the listing needs the service on.
 */
export const recoveryPointTemplateId = (scope: {
  readonly projectId: string;
  readonly region: string;
}) =>
  Effect.gen(function* () {
    const service = { ...scope, serviceId: "cloud.stackit.automation" };
    yield* serviceEnablement.enableServiceRegional(service);
    yield* serviceEnablement.getServiceStatusRegional(service).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (status) => status.state === "ENABLED",
        times: 30,
      }),
    );
    const templates = yield* automation.listVolumeTemplates
      .items({ ...scope, pageSize: 100 })
      .pipe(Stream.runCollect);
    for (const template of templates) {
      const { input } = yield* automation.getVolumeTemplate({
        ...scope,
        templateId: template.id,
      });
      if (input?.kind === "VolumeRecoveryPointManagement") return template.id;
    }
    return yield* new NoRecoveryPointTemplate({
      message: `no VolumeRecoveryPointManagement template in ${scope.region}`,
    });
  });
