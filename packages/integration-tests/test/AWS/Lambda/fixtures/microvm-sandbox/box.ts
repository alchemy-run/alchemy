import * as GitHub from "@alchemy.run/github";
import * as Sandbox from "@alchemy.run/sandbox";

/** A shell with `git`, `gh` and `curl` on two sizes, reaching GitHub only through its gateway. */
export class MicrovmEgressSandbox extends Sandbox.Sandbox<
  MicrovmEgressSandbox,
  { size: "small" | "large"; egress: GitHub.Egress }
>()("MicrovmEgressSandbox", { egress: [GitHub.Egress] }) {}
