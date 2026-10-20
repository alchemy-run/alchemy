import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/** A shell with `git`, `gh` and `curl`, reaching GitHub (and a drip) only through its gateways. */
export class EgressSandbox extends AI.Sandbox<
  EgressSandbox,
  { size: "small"; egress: GitHub.Egress | Egress.Http }
>()("EgressSandbox", { egress: [GitHub.Egress, Egress.Http] }) {}
