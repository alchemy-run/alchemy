import * as GitHub from "@alchemy.run/github";
import * as Sandbox from "@alchemy.run/sandbox";
import * as Egress from "alchemy/Egress";

/** A shell with `git`, `gh` and `curl`, reaching GitHub (and a drip) only through its gateways. */
export class EgressSandbox extends Sandbox.Sandbox<
  EgressSandbox,
  { size: "small"; egress: GitHub.Egress | Egress.Http }
>()("EgressSandbox", { egress: [GitHub.Egress, Egress.Http] }) {}
