import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DEFAULT_STACKIT_REGION,
  STACKIT_AUTH_PROVIDER_NAME,
  type StackitResolvedCredentials,
} from "./AuthProvider.ts";

/**
 * Fully-resolved STACKIT environment for a stack: the default project,
 * organization and region, all taken from the selected Alchemy profile (or
 * the `STACKIT_*` CI environment variables).
 *
 * Project-scoped resources default their `projectId` prop to `projectId`;
 * regional resources default their `region` prop to `region`.
 * Organization-scoped resources (projects, folders) require
 * `organizationId` — read it with {@link requireOrganizationId}.
 */
export interface StackitEnvironmentShape {
  /** Default project id. */
  readonly projectId: string;
  /** Organization id (container id), when the profile names one. */
  readonly organizationId: string | undefined;
  /** Default region, e.g. `eu01`. */
  readonly region: string;
}

/**
 * The STACKIT environment service. Read it inside lifecycle operations with
 * `yield* StackitEnvironment.current`, not at layer build, so each resource
 * resolves it in its own scope.
 */
export class StackitEnvironment extends Context.Service<
  StackitEnvironment,
  Effect.Effect<StackitEnvironmentShape, ConfigError>
>()("Stackit::Environment") {
  static current = StackitEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * The profile's organization id, or a `ConfigError` naming how to set it.
 * Use in organization-scoped resources whose `organizationId` prop is unset.
 */
export const requireOrganizationId = (
  env: StackitEnvironmentShape,
): Effect.Effect<string, ConfigError> =>
  env.organizationId !== undefined && env.organizationId !== ""
    ? Effect.succeed(env.organizationId)
    : Effect.fail(
        ConfigError.make({
          message:
            "STACKIT organization id is required. Pass `organizationId`, set STACKIT_ORGANIZATION_ID, or add it to the Alchemy Stackit profile.",
        }),
      );

const toEnvironment = (
  creds: StackitResolvedCredentials,
): Effect.Effect<StackitEnvironmentShape, ConfigError> =>
  creds.projectId === ""
    ? Effect.fail(
        ConfigError.make({
          message:
            "STACKIT project id is required. Set STACKIT_PROJECT_ID or add it to the Alchemy Stackit profile.",
        }),
      )
    : Effect.succeed({
        projectId: creds.projectId,
        organizationId:
          creds.organizationId === undefined || creds.organizationId === ""
            ? undefined
            : creds.organizationId,
        region: creds.region,
      });

/**
 * Build a `StackitEnvironment` layer from the Stackit auth profile. Like
 * the `Credentials` layer, resolution is deferred to first use and cached.
 */
export const environmentFromAuthProvider = () =>
  Layer.effect(
    StackitEnvironment,
    lazyCredentials<StackitResolvedCredentials, ConfigError>()(
      STACKIT_AUTH_PROVIDER_NAME,
      (creds) => creds,
    ).pipe(Effect.map((resolve) => Effect.flatMap(resolve, toEnvironment))),
  );

/**
 * Pin the environment explicitly (tests, or stacks that deploy into a
 * project other than the profile's).
 */
export const environmentOf = (env: {
  readonly projectId: string;
  readonly organizationId?: string;
  readonly region?: string;
}) =>
  Layer.succeed(
    StackitEnvironment,
    Effect.succeed({
      projectId: env.projectId,
      organizationId: env.organizationId,
      region: env.region ?? DEFAULT_STACKIT_REGION,
    }),
  );
