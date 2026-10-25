import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Dps = Azure.IoT.ProvisioningService("DpsBindingsService");

/**
 * Enrollment IDs for one test run. DPS keeps a deleted ID busy for a while
 * (bulk creates fail, queries still list it), so every run uses fresh IDs.
 */
export const enrollmentIds = (run: string) => ({
  /** Created, read, queried, and deleted by the enrollment-group routes. */
  group: `alchemy-group-${run}`,
  /** Created and deleted in bulk. */
  bulkGroup: `alchemy-bulk-group-${run}`,
  /** Created, read, queried, and deleted by the individual-enrollment routes. */
  enrollment: `alchemy-device-${run}`,
  /** Created and deleted in bulk. */
  bulkEnrollment: `alchemy-bulk-device-${run}`,
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * Effect-native Azure Function exercising every Device Provisioning Service
 * service-API binding on a managed-identity host, one route per behavior.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through the cold start and role propagation.
 */
export default class DpsFunction extends Azure.Functions.Function<DpsFunction>()(
  "DpsBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const dps = yield* Dps;

    const createGroup = yield* Azure.IoT.CreateOrUpdateEnrollmentGroup(dps);
    const getGroup = yield* Azure.IoT.GetEnrollmentGroup(dps);
    const queryGroups = yield* Azure.IoT.QueryEnrollmentGroups(dps);
    const groupAttestation = yield* Azure.IoT.GetEnrollmentGroupAttestationMechanism(dps);
    const bulkGroups = yield* Azure.IoT.RunEnrollmentGroupBulkOperation(dps);
    const deleteGroup = yield* Azure.IoT.DeleteEnrollmentGroup(dps);

    const createEnrollment = yield* Azure.IoT.CreateOrUpdateIndividualEnrollment(dps);
    const getEnrollment = yield* Azure.IoT.GetIndividualEnrollment(dps);
    const queryEnrollments = yield* Azure.IoT.QueryIndividualEnrollments(dps);
    const enrollmentAttestation = yield* Azure.IoT.GetIndividualEnrollmentAttestationMechanism(dps);
    const bulkEnrollments = yield* Azure.IoT.RunIndividualEnrollmentBulkOperation(dps);
    const deleteEnrollment = yield* Azure.IoT.DeleteIndividualEnrollment(dps);

    const getRegistration = yield* Azure.IoT.GetDeviceRegistrationState(dps);
    const queryRegistrations = yield* Azure.IoT.QueryDeviceRegistrationStates(dps);
    const deleteRegistration = yield* Azure.IoT.DeleteDeviceRegistrationState(dps);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const ids = enrollmentIds(url.searchParams.get("run") ?? "");
        switch (url.pathname) {
          case "/groups/create":
            return yield* respond(
              Effect.map(
                createGroup({
                  id: ids.group,
                  enrollmentGroupId: ids.group,
                  attestation: { type: "symmetricKey" },
                  provisioningStatus: "enabled",
                }),
                (group) => ({ id: group.enrollmentGroupId, type: group.attestation.type }),
              ),
            );
          case "/groups/get":
            return yield* respond(
              Effect.gen(function* () {
                const group = yield* getGroup({ id: ids.group });
                const missing = yield* failureTag(getGroup({ id: "no-such-group" }));
                return { id: group.enrollmentGroupId, status: group.provisioningStatus, missing };
              }),
            );
          case "/groups/query":
            return yield* respond(
              Effect.map(queryGroups({ query: "*" }), (groups) => ({
                ids: groups.map((g) => g.enrollmentGroupId).sort(),
              })),
            );
          case "/groups/attestation":
            return yield* respond(
              Effect.map(groupAttestation({ id: ids.group }), (a) => ({
                type: a.type,
                hasKey: (a.symmetricKey?.primaryKey?.length ?? 0) > 0,
              })),
            );
          case "/groups/bulk-create":
            return yield* respond(
              bulkGroups({
                mode: "create",
                enrollmentGroups: [
                  { enrollmentGroupId: ids.bulkGroup, attestation: { type: "symmetricKey" } },
                ],
              }),
            );
          case "/groups/bulk-delete":
            return yield* respond(
              bulkGroups({
                mode: "delete",
                enrollmentGroups: [
                  { enrollmentGroupId: ids.bulkGroup, attestation: { type: "symmetricKey" } },
                ],
              }),
            );
          case "/groups/delete":
            return yield* respond(deleteGroup({ id: ids.group }));
          case "/enrollments/create":
            return yield* respond(
              Effect.map(
                createEnrollment({
                  id: ids.enrollment,
                  registrationId: ids.enrollment,
                  attestation: { type: "symmetricKey" },
                  provisioningStatus: "enabled",
                }),
                (e) => ({ id: e.registrationId, type: e.attestation.type }),
              ),
            );
          case "/enrollments/get":
            return yield* respond(
              Effect.gen(function* () {
                const e = yield* getEnrollment({ id: ids.enrollment });
                const missing = yield* failureTag(getEnrollment({ id: "no-such-device" }));
                return { id: e.registrationId, status: e.provisioningStatus, missing };
              }),
            );
          case "/enrollments/query":
            return yield* respond(
              Effect.map(queryEnrollments({ query: "*" }), (enrollments) => ({
                ids: enrollments.map((e) => e.registrationId).sort(),
              })),
            );
          case "/enrollments/attestation":
            return yield* respond(
              Effect.map(enrollmentAttestation({ id: ids.enrollment }), (a) => ({
                type: a.type,
                hasKey: (a.symmetricKey?.primaryKey?.length ?? 0) > 0,
              })),
            );
          case "/enrollments/bulk-create":
            return yield* respond(
              bulkEnrollments({
                mode: "create",
                enrollments: [
                  { registrationId: ids.bulkEnrollment, attestation: { type: "symmetricKey" } },
                ],
              }),
            );
          case "/enrollments/bulk-delete":
            return yield* respond(
              bulkEnrollments({
                mode: "delete",
                enrollments: [
                  { registrationId: ids.bulkEnrollment, attestation: { type: "symmetricKey" } },
                ],
              }),
            );
          case "/enrollments/delete":
            return yield* respond(deleteEnrollment({ id: ids.enrollment }));
          case "/registrations/get":
            return yield* respond(
              Effect.map(failureTag(getRegistration({ id: ids.enrollment })), (tag) => ({ tag })),
            );
          case "/registrations/query":
            return yield* respond(
              Effect.map(queryRegistrations({ id: ids.group }), (states) => ({
                ids: states.map((s) => s.registrationId),
              })),
            );
          case "/registrations/delete":
            return yield* respond(
              Effect.map(failureTag(deleteRegistration({ id: ids.enrollment })), (tag) => ({
                tag,
              })),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.IoT.CreateOrUpdateEnrollmentGroupHttp,
        Azure.IoT.GetEnrollmentGroupHttp,
        Azure.IoT.QueryEnrollmentGroupsHttp,
        Azure.IoT.GetEnrollmentGroupAttestationMechanismHttp,
        Azure.IoT.RunEnrollmentGroupBulkOperationHttp,
        Azure.IoT.DeleteEnrollmentGroupHttp,
        Azure.IoT.CreateOrUpdateIndividualEnrollmentHttp,
        Azure.IoT.GetIndividualEnrollmentHttp,
        Azure.IoT.QueryIndividualEnrollmentsHttp,
        Azure.IoT.GetIndividualEnrollmentAttestationMechanismHttp,
        Azure.IoT.RunIndividualEnrollmentBulkOperationHttp,
        Azure.IoT.DeleteIndividualEnrollmentHttp,
        Azure.IoT.GetDeviceRegistrationStateHttp,
        Azure.IoT.QueryDeviceRegistrationStatesHttp,
        Azure.IoT.DeleteDeviceRegistrationStateHttp,
      ),
    ),
  ),
) {}
