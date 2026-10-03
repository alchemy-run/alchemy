import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

/**
 * File-based fixture for `Cloudflare.Workers.EventTriggers`: a Worker that
 * hosts the Workflow an Artifacts event starts. The test supplies the
 * triggers, so create → update → clear reuse this file.
 */
export class PushWorkflow extends WorkflowEntrypoint {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
    return await step.do("record", async () => ({ event: event.payload }));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
