import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/** A public repository the gateway may read (and nothing else). */
export const READ_REPO = "alchemy-run/alchemy";

/** A gateway hosted on AWS Lambda: read-only GitHub. */
export class LambdaTestGateway extends Egress.Gateway<LambdaTestGateway>()(
  "EgressLambdaTestGateway",
  { repo: GitHub.Egress },
) {}
