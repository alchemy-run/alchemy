import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";

/** A shell with `git`, `gh` and `curl` on two sizes, reaching GitHub only through its gateway. */
export class MicrovmEgressSandbox extends AI.Sandbox<
  MicrovmEgressSandbox,
  { size: "small" | "large"; egress: GitHub.Egress }
>()("MicrovmEgressSandbox", { egress: [GitHub.Egress] }) {}
