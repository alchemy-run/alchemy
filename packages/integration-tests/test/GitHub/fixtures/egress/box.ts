import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";

/** A shell for `gh` and `git`, with GitHub access only through its gateway. */
export class EgressBox extends AI.Sandbox<EgressBox, { size: "small"; egress: GitHub.Egress }>()(
  "GitHubEgressBox",
  { egress: [GitHub.Egress] },
) {}
