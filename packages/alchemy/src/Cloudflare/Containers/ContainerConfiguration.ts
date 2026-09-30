import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  AnyContainerApplicationProps,
  DurableObjectContainerProps,
} from "./ContainerApplication.ts";

export class ContainerConfigurationError extends Data.TaggedError(
  "ContainerConfigurationError",
)<{ readonly message: string }> {}

export class ContainerImagePreparationError extends Data.TaggedError(
  "ContainerImagePreparationError",
)<{
  readonly image: string;
  readonly status: "pending" | "error";
  readonly message: string;
}> {}

export const isDurableObjectContainer = (
  props: AnyContainerApplicationProps,
): props is DurableObjectContainerProps =>
  props.schedulingPolicy === "durable_object";

/** Validate before publishing images or changing the hosting Worker. */
export const validateContainerConfiguration = Effect.fn(function* (
  props: AnyContainerApplicationProps,
  previousPolicy?: string,
) {
  const values: AnyContainerApplicationProps = props;
  const policy = props.schedulingPolicy ?? "default";
  if (previousPolicy !== undefined && previousPolicy !== policy) {
    return yield* new ContainerConfigurationError({
      message:
        "A container's scheduling policy cannot change in place. Declare a new container application and Durable Object class, then move traffic to the new namespace. Existing Durable Object storage is not transferred.",
    });
  }
  if (!isDurableObjectContainer(props)) {
    if (props.images !== undefined) {
      return yield* new ContainerConfigurationError({
        message: "Named images require schedulingPolicy: 'durable_object'.",
      });
    }
    return;
  }

  const imageNames = Object.keys(props.images ?? {});
  if (imageNames.length > 100) {
    return yield* new ContainerConfigurationError({
      message:
        "A Durable Object-managed container supports at most 100 named images.",
    });
  }
  for (const name of imageNames) {
    if (name.length === 0 || name.length > 128) {
      return yield* new ContainerConfigurationError({
        message:
          "A container image name must contain between 1 and 128 characters.",
      });
    }
  }

  for (const key of [
    "main",
    "image",
    "context",
    "dockerfile",
    "instanceType",
    "instances",
    "maxInstances",
    "vcpu",
    "memory",
    "memoryMib",
    "disk",
    "env",
    "environmentVariables",
    "secrets",
    "labels",
    "network",
    "command",
    "entrypoint",
    "dns",
    "ports",
    "checks",
    "constraints",
    "affinities",
    "rollout",
    "registryId",
    "publish",
    "sshPublicKeyIds",
  ] as const) {
    if (values[key] !== undefined) {
      return yield* new ContainerConfigurationError({
        message: `Container property '${key}' is not supported with schedulingPolicy: 'durable_object'. Declare image sources under 'images' and pass per-instance settings to start().`,
      });
    }
  }
});
