import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/** Two public repositories on one host: each gateway serves one. */
export const REPO_A = "alchemy-run/alchemy";
export const REPO_B = "alchemy-run/distilled";

/**
 * A slow upstream on a host of its own: `/drip` streams one byte per second
 * (DESIGN.md §8: a host whose props don't change is never re-intercepted).
 */
export const DRIP_HOST = "httpbin.org";

/** The response header each gateway adds, naming itself. */
export const GATEWAY_HEADER = "x-alchemy-test-gateway";

export class GatewayA extends Egress.Gateway<GatewayA>()("SandboxEgressGatewayA", {
  repo: GitHub.Egress,
  drip: Egress.Http,
}) {}

export class GatewayB extends Egress.Gateway<GatewayB>()("SandboxEgressGatewayB", {
  repo: GitHub.Egress,
}) {}
