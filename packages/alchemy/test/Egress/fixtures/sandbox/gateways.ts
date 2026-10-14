import * as Egress from "@/Egress/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** Two public repositories on one host: each gateway serves one. */
export const REPO_A = "alchemy-run/alchemy";
export const REPO_B = "alchemy-run/distilled";

/** The response header each gateway adds, naming itself. */
export const GATEWAY_HEADER = "x-alchemy-test-gateway";

export class GatewayA extends Egress.Gateway<GatewayA>()("SandboxEgressGatewayA", {
  repo: GitHub.Egress,
}) {}

export class GatewayB extends Egress.Gateway<GatewayB>()("SandboxEgressGatewayB", {
  repo: GitHub.Egress,
}) {}
