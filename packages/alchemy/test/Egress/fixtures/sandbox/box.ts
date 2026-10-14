import * as AI from "@/AI/index.ts";
import * as Egress from "@/Egress/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** A shell with `git`, `gh` and `curl`, reaching GitHub (and a drip) only through its gateways. */
export class EgressSandbox extends AI.Sandbox<
  EgressSandbox,
  { size: "small"; egress: GitHub.Egress | Egress.Http }
>()("EgressSandbox", { egress: [GitHub.Egress, Egress.Http] }) {}
