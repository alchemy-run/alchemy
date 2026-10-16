import * as Egress from "@/Egress/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** Serves the sandbox's GitHub access: the token stays in its Worker. */
export class GitHubEgressGateway extends Egress.Gateway<GitHubEgressGateway>()(
  "GitHubEgressGateway",
  { repo: GitHub.Egress },
) {}
