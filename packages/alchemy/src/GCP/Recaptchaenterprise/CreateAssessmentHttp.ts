import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  CreateAssessment,
  type CreateAssessmentRequest,
} from "./CreateAssessment.ts";
import { lastSegment } from "./internal.ts";
import type { Key } from "./Key.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link CreateAssessment}.
 *
 * @layer
 * @provides GCP.Recaptchaenterprise.CreateAssessment
 */
export const CreateAssessmentHttp = Layer.effect(
  CreateAssessment,
  Effect.gen(function* () {
    const createProjectsAssessments =
      yield* recaptchaenterprise.createProjectsAssessments;
    return Effect.fn(function* <K extends Key>(key: K) {
      yield* bindGcpHost({
        tag: "GCP.Recaptchaenterprise.CreateAssessment",
        resource: key,
        iam: [
          { role: defaultRoleFor("GCP.Recaptchaenterprise.CreateAssessment") },
        ],
      });
      const name = yield* key.name;
      return Effect.fn(
        `GCP.Recaptchaenterprise.CreateAssessment(${key.LogicalId})`,
      )(function* (request?: CreateAssessmentRequest) {
        const keyName = yield* name;
        const parts = keyName.split("/").filter((part) => part.length > 0);
        const projectAt = parts.lastIndexOf("projects");
        const project =
          projectAt >= 0 && parts[projectAt + 1] ? parts[projectAt + 1]! : "";
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
