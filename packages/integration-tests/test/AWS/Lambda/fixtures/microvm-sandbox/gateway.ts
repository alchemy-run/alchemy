import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/** Two public repositories the gateway serves, read-only. */
export const REPO_A = "alchemy-run/alchemy";
export const REPO_B = "alchemy-run/distilled";

/** The response header the gateway adds, so a test can tell a request went through it. */
export const GATEWAY_HEADER = "x-alchemy-test-gateway";

export class MicrovmSandboxGateway extends Egress.Gateway<MicrovmSandboxGateway>()(
  "MicrovmSandboxGateway",
  { repo: GitHub.Egress },
) {}
