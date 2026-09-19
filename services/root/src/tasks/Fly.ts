import * as AI from "alchemy/AI";
import { Engineer } from "../engineering/Engineer.ts";
import { Reviewer } from "../engineering/Reviewer.ts";

/**
 * The FLY work stream — the second `AI.TaskQueue`: Fly.io provider
 * work (machines, deploys, certificates, volumes) flows through this
 * lane. Same shape as the Cloudflare queue — the same Engineer
 * IDENTITY holds a different DESK here
 * (`root::tasks::fly::engineer`), so what the Cloudflare desk
 * teaches it flows across through the self digest.
 */
export class FlyTasks extends AI.TaskQueue<FlyTasks>(import.meta)("Fly") {}

export const FlyTasksLive = FlyTasks.make`
  Fly.io work: machine lifecycle bugs, blue/green deploy safety,
  ACME certificates, volumes, provider gaps. ${Engineer} implements
  — one task at a time, in a workspace per task. ${Reviewer} gates
  every review; changes bounce back with the review attached. Park
  anything blocked on Fly platform behavior with a reason. Escalate
  repeated failures to the manager.`;
