import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** A shell for `gh` and `git`, with GitHub access only through its gateway. */
export class EgressBox extends AI.Sandbox<EgressBox, { size: "small"; egress: GitHub.Egress }>()(
  "GitHubEgressBox",
  { egress: [GitHub.Egress] },
) {}
