import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { Release } from "./Release.ts";

export interface GetReleaseExecutableRequest extends Omit<
  firebaserules.GetExecutableProjectsReleasesRequest,
  "name"
> {}

/**
 * Runtime binding for Firebase Rules `releases.getExecutable`.
 *
 * Bind this operation to a {@link Release} in a Function/Action init
 * phase. Provide {@link GetReleaseExecutableHttp}.
 *
 * ### Reading a Release Executable
 * **Example:** Fetch the compiled executable
 * ```typescript
 * const getExecutable = yield* GCP.FirebaseRules.GetReleaseExecutable(
 *   release,
 * );
 * const { rulesetName, executableVersion } = yield* getExecutable();
 * ```
 *
 * @binding
 * @category FirebaseRules
 */
export interface GetReleaseExecutable extends Binding.Service<
  GetReleaseExecutable,
  "GCP.FirebaseRules.GetReleaseExecutable",
  (
    release: Release,
  ) => Effect.Effect<
    (
      request?: GetReleaseExecutableRequest,
    ) => Effect.Effect<
      firebaserules.GetReleaseExecutableResponse,
      firebaserules.GetExecutableProjectsReleasesError,
      RuntimeContext
    >
  >
> {}

export const GetReleaseExecutable = Binding.Service<GetReleaseExecutable>(
  "GCP.FirebaseRules.GetReleaseExecutable",
);

/**
 * HTTP implementation of {@link GetReleaseExecutable}.
 *
 * Grants `roles/firebaserules.admin` on the project because it is the
 * narrowest predefined role containing `firebaserules.releases.getExecutable`, and Firebase
 * Rules has no resource-level IAM.
 *
 * @layer
 * @provides GCP.FirebaseRules.GetReleaseExecutable
 */
export const GetReleaseExecutableHttp = Layer.effect(
  GetReleaseExecutable,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getExecutableProjectsReleases = yield* GCPBindings.withCredentials(
      firebaserules.getExecutableProjectsReleases,
    );
    return Effect.fn(function* (release: Release) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.FirebaseRules.GetReleaseExecutable(${release})`({
          iam: [{ role: "roles/firebaserules.admin" }],
        });
      }
      const name = yield* release.name;
      return Effect.fn(`GCP.FirebaseRules.GetReleaseExecutable(${release.LogicalId})`)(function* (
        request: GetReleaseExecutableRequest = {},
      ) {
        return yield* getExecutableProjectsReleases({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
