import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
  DurableObjectContainerProps,
} from "./ContainerApplication.ts";

export class ContainerConfigurationError extends Data.TaggedError("ContainerConfigurationError")<{
  readonly message: string;
}> {}

export class ContainerImagePreparationError extends Data.TaggedError(
  "ContainerImagePreparationError",
)<{
  readonly image: string;
  readonly status: "pending" | "error";
  readonly message: string;
}> {}

/** Cloudflare's limits for the `images` map of a Durable Object container. */
const MAX_NAMED_IMAGES = 100;
const MAX_IMAGE_NAME_LENGTH = 128;

/**
 * Fleet-scheduled settings that have no meaning when the Durable Object picks
 * the image and instance size at `start()` time.
 */
const FLEET_ONLY_PROPS = [
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
] as const satisfies ReadonlyArray<keyof AnyContainerApplicationProps>;

export const isDurableObjectContainer = (
  props: AnyContainerApplicationProps,
): props is DurableObjectContainerProps => props.schedulingPolicy === "durable_object";

const invalid = (message: string) => Effect.fail(new ContainerConfigurationError({ message }));

/**
 * Validate container props before publishing images or touching the hosting
 * Worker. Pass the deployed scheduling policy to reject in-place switches.
 */
export const validateContainerConfiguration = Effect.fn(function* (
  props: AnyContainerApplicationProps,
  deployedPolicy?: string,
) {
  const policy = props.schedulingPolicy ?? "default";
  if (deployedPolicy !== undefined && deployedPolicy !== policy) {
    return yield* invalid(
      "A container's scheduling policy cannot change in place. Declare a new container application and Durable Object class, then move traffic to the new namespace. Existing Durable Object storage is not transferred.",
    );
  }

  if (!isDurableObjectContainer(props)) {
    if (props.images !== undefined) {
      return yield* invalid("Named images require schedulingPolicy: 'durable_object'.");
    }
    return;
  }

  const imageNames = Object.keys(props.images ?? {});
  if (imageNames.length > MAX_NAMED_IMAGES) {
    return yield* invalid(
      `A Durable Object-managed container supports at most ${MAX_NAMED_IMAGES} named images.`,
    );
  }
  const badName = imageNames.find(
    (name) => name.length === 0 || name.length > MAX_IMAGE_NAME_LENGTH,
  );
  if (badName !== undefined) {
    return yield* invalid(
      `Container image name '${badName}' must contain between 1 and ${MAX_IMAGE_NAME_LENGTH} characters.`,
    );
  }

  // The union type already forbids these, but untyped or Effect-produced
  // props can still carry them.
  const loose: AnyContainerApplicationProps = props;
  const unsupported = FLEET_ONLY_PROPS.find((key) => loose[key] !== undefined);
  if (unsupported !== undefined) {
    return yield* invalid(
      `Container property '${unsupported}' is not supported with schedulingPolicy: 'durable_object'. Declare image sources under 'images' and pass per-instance settings to start().`,
    );
  }
});

/**
 * The `containers` entry a Durable Object class contributes to its Worker.
 * Durable Object-managed applications also send their application name and
 * prepared images so the Worker upload can expose `ctx.container.images`.
 */
export const workerContainerBinding = (className: string, application: ContainerApplication) => ({
  className,
  name: Output.all(application.schedulingPolicy, application.applicationName).pipe(
    Output.map(([policy, name]) => (policy === "durable_object" ? name : undefined)),
  ),
  images: application.images,
  devImages: application.devImages,
  dev: application.dev,
  hash: application.hash.pipe(Output.map((hash) => hash?.image)),
});
