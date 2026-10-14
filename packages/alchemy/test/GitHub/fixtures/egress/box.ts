import * as AI from "@/AI/index.ts";

/** A shell for `gh` and `git`, with GitHub access only through its Durable Object's egress. */
export class EgressBox extends AI.Sandbox<EgressBox, { size: "small" }>()("GitHubEgressBox") {}
