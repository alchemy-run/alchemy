import * as AI from "alchemy/AI";
import { Engineer } from "../engineering/Engineer.ts";
import { Reviewer } from "../engineering/Reviewer.ts";

/**
 * The CLOUDFLARE work stream — the first `AI.TaskQueue`: provider
 * work on the Cloudflare surface flows through this lane, worked by
 * ONE standing engineer desk (`root::tasks::cloudflare::engineer`)
 * that accumulates the stream's context task after task, gated by
 * one reviewer desk. The structure is code: the splices ARE the
 * desks.
 */
export class CloudflareTasks extends AI.TaskQueue<CloudflareTasks>(
  import.meta,
)("Cloudflare") {}

export const CloudflareTasksLive = CloudflareTasks.make`
  Cloudflare work: provider bugs, distilled patches, live-test
  failures, new resources. ${Engineer} implements — one task at a
  time, in a workspace per task. ${Reviewer} gates every review;
  changes bounce back with the review attached. Park anything
  blocked on entitlements or upstream with a reason. Escalate
  repeated failures to the manager.`;
