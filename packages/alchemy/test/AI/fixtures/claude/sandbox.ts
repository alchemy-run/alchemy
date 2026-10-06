import * as Cloudflare from "@/Cloudflare";

/** The box Claude Code runs in — declared bare so the DO bundle stays small. */
export class AgentSandbox extends Cloudflare.Container<AgentSandbox, {}>()("AgentSandbox") {}
