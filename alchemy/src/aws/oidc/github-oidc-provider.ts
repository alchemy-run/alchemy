import { OIDCProvider, type OIDCProviderProps } from "./oidc-provider";

/**
 * Default thumbprint for GitHub's OIDC provider
 * This is the certificate thumbprint that GitHub uses to sign OIDC tokens
 * @see https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services#adding-the-identity-provider-to-aws
 */
const DEFAULT_GITHUB_THUMBPRINT = "6938fd4d98bab03faadb97b34396831e3780aea1";

export interface GitHubOIDCProviderProps
  extends Omit<OIDCProviderProps, "thumbprint"> {
  owner: string;
  repository: string;
}
export type GitHubOIDCProvider = ReturnType<typeof GitHubOIDCProvider>;

export const GitHubOIDCProvider = async (
  id: string,
  props: GitHubOIDCProviderProps,
) => {
  return OIDCProvider(id, {
    owner: props.owner,
    repository: props.repository,
    roleArn: props.roleArn,
    branches: props.branches,
    environments: props.environments,
    thumbprint: DEFAULT_GITHUB_THUMBPRINT,
  });
};
