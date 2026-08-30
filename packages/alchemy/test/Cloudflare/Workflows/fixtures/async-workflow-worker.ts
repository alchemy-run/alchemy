import { WorkflowEntrypoint } from "cloudflare:workers";

export class ExistingWorkflow extends WorkflowEntrypoint {
  async run() {
    return "ok";
  }
}

export default {
  async fetch() {
    return new Response("ok");
  },
};
