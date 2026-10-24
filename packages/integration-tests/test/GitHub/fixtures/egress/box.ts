import * as GitHub from "@alchemy.run/github";
import * as Sandbox from "@alchemy.run/sandbox";

/** A shell for `gh` and `git`, with GitHub access only through its gateway. */
export class EgressBox extends Sandbox.Sandbox<
  EgressBox,
  { size: "small"; egress: GitHub.Egress }
>()("GitHubEgressBox", { egress: [GitHub.Egress] }) {}
