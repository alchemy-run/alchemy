import type { Config } from "@distilled.cloud/gcp/Credentials";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class GcpProjectMissing extends Data.TaggedError("GCP.ProjectMissing")<{
  message: string;
}> {}

/**
 * Fully-resolved GCP environment for a stack.
 *
 * Distilled GCP authenticates with a bearer access token; Alchemy always
 * pairs it with a project id so lifecycle operations can fill
 * `projects/{project}/...` resource names.
 */
export interface GcpEnvironmentShape {
  accessToken: Redacted.Redacted<string>;
  project: string;
}

export class GcpEnvironment extends Context.Service<
  GcpEnvironment,
  Effect.Effect<GcpEnvironmentShape, GcpProjectMissing>
>()("GCP::Environment") {
  static current = GcpEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

const requireProject = (
  config: Config,
): Effect.Effect<GcpEnvironmentShape, GcpProjectMissing> => {
  if (!config.project) {
    return Effect.fail(
      new GcpProjectMissing({
        message:
          "GCP project id is required. Set GOOGLE_PROJECT_ID or configure the Alchemy GCP profile.",
      }),
    );
  }
  return Effect.succeed({
    accessToken: config.accessToken,
    project: config.project,
  });
};

/**
 * Build a `GcpEnvironment` layer from the distilled `Credentials`
 * service. Provide this after `Credentials.fromAuthProvider()`.
 */
export const fromCredentials = () =>
  Layer.effect(
    GcpEnvironment,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      return Effect.flatMap(credentials, requireProject);
    }),
  );
