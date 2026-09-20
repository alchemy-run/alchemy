import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export class ValidationWorkflow extends WorkflowEntrypoint<
  unknown,
  { value: string }
> {
  async run(
    event: Readonly<WorkflowEvent<{ value: string }>>,
    step: WorkflowStep,
  ) {
    return step.do("value", async () => event.payload);
  }
}
