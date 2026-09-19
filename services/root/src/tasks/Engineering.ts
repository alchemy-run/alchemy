import * as AI from "alchemy/AI";
import { Engineer } from "../engineering/Engineer.ts";
import { Reviewer } from "../engineering/Reviewer.ts";

/**
 * The ENGINEERING work stream — the ONE `AI.TaskQueue`: provider
 * work across every cloud flows through this single lane, worked by
 * ONE standing engineer desk (`root::tasks::engineering::engineer`)
 * that accumulates the stream's context task after task, gated by
 * one reviewer desk. TAGS, not queues, carry the area (Tags.ts) —
 * the structure is code: the splices ARE the desks.
 */
export class EngineeringTasks extends AI.TaskQueue<EngineeringTasks>(
  import.meta,
)("Engineering") {}

export const EngineeringTasksLive = EngineeringTasks.make`
  Provider work across clouds — Cloudflare, Fly, AWS, distilled
  patches, the forge, the org's own plumbing: provider bugs,
  live-test failures, new resources, deploy safety. Tag each task
  with its area. ${Engineer} implements — one task at a time, in a
  workspace per task. ${Reviewer} gates every review; changes bounce
  back with the review attached. Park anything blocked on
  entitlements, platform behavior, or upstream with a reason.
  Escalate repeated failures to the manager.`;
