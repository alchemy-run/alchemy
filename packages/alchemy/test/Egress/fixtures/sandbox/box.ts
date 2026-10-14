import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** A shell with `git` and `gh`, reaching GitHub only through its gateways. */
export class EgressSandbox extends AI.Sandbox<
  EgressSandbox,
  { size: "small"; egress: GitHub.Egress }
>()("EgressSandbox", { egress: [GitHub.Egress] }) {}
