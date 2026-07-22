/**
 * A two-agent team: the Lead delegates, the Engineer does. Exercises
 * the delegation seam — `${Engineer}` in the Lead's charter compiles
 * into a delegate tool whose handler dispatches into the Engineer's
 * OWN Actor (fresh run, fresh conversation) and awaits the answer.
 */
import * as AI from "@/AI/index.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer")`
You implement exactly the task you are handed, and reply with what
you did — nothing else.` {}

export class Lead extends AI.Agent<Lead>()("Lead")`
You run engineering. Turn every request into implementation tasks
and hand them to ${Engineer}; when the work comes back, report what
was done.` {}
