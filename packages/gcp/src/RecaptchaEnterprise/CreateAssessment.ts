import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { lastSegment } from "./internal.ts";
import type { Key } from "./Key.ts";

export interface CreateAssessmentRequest extends Omit<
  recaptchaenterprise.CreateProjectsAssessmentsRequest,
  "parent"
> {}

/**
 * Runtime binding for reCAPTCHA Enterprise `assessments.create`.
 *
 * Bind this operation to a {@link Key} in a Function/Action init phase.
 * Provide {@link CreateAssessmentHttp}. The key's site key is filled in
 * on `event.siteKey` when omitted.
 *
 * ### Creating an Assessment
 * **Example:** Assess a login event
 * ```typescript
 * const createAssessment = yield* GCP.RecaptchaEnterprise.CreateAssessment(
 *   key,
 * );
 * const assessment = yield* createAssessment({
 *   body: {
 *     event: {
 *       token: recaptchaToken,
 *       expectedAction: "login",
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category RecaptchaEnterprise
 */
export interface CreateAssessment extends Binding.Service<
  CreateAssessment,
  "GCP.RecaptchaEnterprise.CreateAssessment",
  (
    key: Key,
  ) => Effect.Effect<
    (
      request?: CreateAssessmentRequest,
    ) => Effect.Effect<
      recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1Assessment,
      recaptchaenterprise.CreateProjectsAssessmentsError,
      RuntimeContext
    >
  >
> {}

export const CreateAssessment = Binding.Service<CreateAssessment>(
  "GCP.RecaptchaEnterprise.CreateAssessment",
);

/**
 * HTTP implementation of {@link CreateAssessment}.
 *
 * @layer
 * @provides GCP.RecaptchaEnterprise.CreateAssessment
 */
export const CreateAssessmentHttp = Layer.effect(
  CreateAssessment,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createProjectsAssessments = yield* GCPBindings.withCredentials(
      recaptchaenterprise.createProjectsAssessments,
    );
    return Effect.fn(function* <K extends Key>(key: K) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.RecaptchaEnterprise.CreateAssessment(${key})`({
          // reCAPTCHA keys have no resource-level IAM.
          iam: [{ role: "roles/recaptchaenterprise.agent" }],
        });
      }
      const name = yield* key.name;
      return Effect.fn(`GCP.RecaptchaEnterprise.CreateAssessment(${key.LogicalId})`)(function* (
        request?: CreateAssessmentRequest,
      ) {
        const keyName = yield* name;
        const parts = keyName.split("/").filter((part) => part.length > 0);
        const projectAt = parts.lastIndexOf("projects");
        const project = projectAt >= 0 && parts[projectAt + 1] ? parts[projectAt + 1]! : "";
        const siteKey = lastSegment(keyName);
        return yield* createProjectsAssessments({
          parent: `projects/${project}`,
          body: {
            ...request?.body,
            event: {
              ...request?.body?.event,
              siteKey: request?.body?.event?.siteKey ?? siteKey,
            },
          },
        });
      });
    });
  }),
);
