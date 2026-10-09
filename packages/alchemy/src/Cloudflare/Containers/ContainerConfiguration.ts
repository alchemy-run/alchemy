import type * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { deepEqual } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
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

/** Validate a bounded preparation deadline before publishing any images. */
export const imagePreparationTimeoutMillis = (timeout: Duration.Input = "30 minutes") =>
  Effect.try({
    try: () => {
      const millis = Duration.toMillis(timeout);
      if (!Number.isFinite(millis) || millis <= 0) throw new Error("Invalid timeout");
      return millis;
    },
    catch: () =>
      new ContainerConfigurationError({
        message: "imagePreparationTimeout must be a finite, positive duration.",
      }),
  });

/**
 * Validate container props before publishing images or touching the hosting
 * Worker. Reject switches between fleet scheduling and Durable Object scheduling.
 */
export const validateContainerConfiguration = Effect.fn(function* (
  props: AnyContainerApplicationProps,
  deployedPolicy?: string,
) {
  const policy = props.schedulingPolicy ?? "default";
  if (
    deployedPolicy !== undefined &&
    (deployedPolicy === "durable_object") !== (policy === "durable_object")
  ) {
    return yield* invalid(
      "A container cannot switch between fleet and Durable Object scheduling in place. Declare a new container application and Durable Object class, then move traffic to the new namespace. Existing Durable Object storage is not transferred.",
    );
  }

  if (!isDurableObjectContainer(props)) {
    if (props.images !== undefined) {
      return yield* invalid("Named images require schedulingPolicy: 'durable_object'.");
    }
    return;
  }

  yield* imagePreparationTimeoutMillis(props.imagePreparationTimeout);
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

/**
 * Converge declared settings and reset settings removed from a prior declaration.
 * Omitted settings on new or adopted applications remain unmanaged.
 */
export const durableObjectSettingsPatch = (
  news: DurableObjectContainerProps,
  olds: AnyContainerApplicationProps | undefined,
  observed: Pick<Containers.GetContainerApplicationResponse, "configuration" | "observability">,
): Pick<Containers.UpdateContainerApplicationRequest, "configuration" | "observability"> => {
  const configuration: Containers.DurableObjectContainerConfiguration = {
    // Cloudflare names the SSH setting after the CLI that connects to it.
    ...(news.ssh !== undefined
      ? { wranglerSsh: news.ssh }
      : olds?.ssh !== undefined
        ? { wranglerSsh: { enabled: false } }
        : {}),
    ...(news.authorizedKeys !== undefined
      ? { authorizedKeys: news.authorizedKeys }
      : olds?.authorizedKeys !== undefined
        ? { authorizedKeys: [] }
        : {}),
  };
  const observability =
    news.observability ??
    (olds?.observability !== undefined ? { logs: { enabled: false } } : undefined);
  const configurationChanged = Object.entries(configuration).some(
    ([key, value]) =>
      !deepEqual(value, normalizeNulls(observed.configuration[key as keyof typeof configuration])),
  );
  return {
    ...(configurationChanged ? { configuration } : {}),
    ...(observability !== undefined &&
    !deepEqual(observability, normalizeNulls(observed.observability))
      ? { observability }
      : {}),
  };
};

/** Common attributes before a Durable Object-managed application exists remotely. */
export const durableObjectPlaceholder = (
  identity: Pick<
    ContainerApplication["Attributes"],
    "applicationId" | "applicationName" | "accountId" | "createdAt" | "observability"
  >,
): ContainerApplication["Attributes"] => ({
  ...identity,
  schedulingPolicy: "durable_object",
  instances: undefined,
  maxInstances: undefined,
  constraints: undefined,
  affinities: undefined,
  configuration: {},
  durableObjects: undefined,
  version: undefined,
  dev: undefined,
});

export const namedImageHash = (images: Record<string, string>) =>
  Effect.map(sha256Object(images), (image) => ({ image, images }));
