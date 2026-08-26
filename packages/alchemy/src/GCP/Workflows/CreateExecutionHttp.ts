import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  CreateExecution,
  type CreateExecutionRequest,
} from "./CreateExecution.ts";
import type { Workflow } from "./Workflow.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link CreateExecution}.
 *
 * @layer
 * @provides GCP.Workflows.CreateExecution
 */
export const CreateExecutionHttp = Layer.effect(
  CreateExecution,
  Effect.gen(function* () {
    const createExecution =
      yield* workflowexecutions.createProjectsLocationsWorkflowsExecutions;
    return Effect.fn(function* (workflow: Workflow) {
      yield* bindGcpHost({
        tag: "GCP.Workflows.CreateExecution",
        resource: workflow,
        iam: [{ role: defaultRoleFor("GCP.Workflows.CreateExecution") }],
      });
      const name = yield* workflow.name;
      return Effect.fn(`GCP.Workflows.CreateExecution(${workflow.LogicalId})`)(
        function* (request?: CreateExecutionRequest) {
          return yield* createExecution({
            ...request,
            parent: yield* name,
          });
        },
      );
    });
  }),
);
