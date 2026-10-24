import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";

/** Serves the sandbox's GitHub access: the token stays in its Worker. */
export class GitHubEgressGateway extends Egress.Gateway<GitHubEgressGateway>()(
  "GitHubEgressGateway",
  { repo: GitHub.Egress },
) {}
