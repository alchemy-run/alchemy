import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ApplicationActivation } from "./Application.ts";
import { DeploymentError } from "./Deployment/Objects.ts";
import { FleetManagement, FleetManagementError } from "./Management.ts";
import { FleetOperator, OperatorError } from "./OperatorClient.ts";

const management = Effect.serviceOption(FleetManagement).pipe(
  Effect.flatMap((service) =>
    Option.isSome(service)
      ? Effect.succeed(service.value)
      : Effect.fail(
          new FleetManagementError({
            reason: "configuration",
            message:
              "The fleet host must provide private management transport.",
          }),
        ),
  ),
);

/** Resolve host management from lifecycle scope, rather than building an AWS client for every host. */
export const ManagementBindings = Layer.mergeAll(
  Layer.succeed(ApplicationActivation, {
    activate: (connection, root, workers) =>
      management.pipe(
        Effect.flatMap((service) =>
          service.activate(connection, {
            root: { pointer: root.pointer, manifest: root.manifest },
            workers: workers.map(({ pointer, manifest }) => ({
              pointer,
              manifest,
            })),
          }),
        ),
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new DeploymentError({
              reason:
                cause.reason === "unobservable"
                  ? "unsupported"
                  : "configuration",
              message: cause.message,
            }),
        ),
      ),
  }),
  Layer.succeed(FleetOperator, {
    execD1: (connection, input) =>
      management.pipe(
        Effect.flatMap((service) => service.operator.execD1(connection, input)),
        Effect.mapError(
          (cause) => new OperatorError({ message: cause.message }),
        ),
      ),
    executeD1Statements: (connection, input) =>
      management.pipe(
        Effect.flatMap((service) =>
          service.operator.executeD1Statements(connection, input),
        ),
        Effect.mapError(
          (cause) => new OperatorError({ message: cause.message }),
        ),
      ),
    migrateD1: (connection, input) =>
      management.pipe(
        Effect.flatMap((service) =>
          service.operator.migrateD1(connection, input),
        ),
        Effect.mapError(
          (cause) => new OperatorError({ message: cause.message }),
        ),
      ),
  }),
);
