import type { Input } from "../../input";
import { isOutput } from "../../output";
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
  thumbprint?: string;
}

export class GitHubOIDCProvider extends OIDCProvider {
  constructor(id: string, props: Input<GitHubOIDCProviderProps>) {
    super(
      id,
      isOutput<GitHubOIDCProviderProps>(props)
        ? props.apply((props) => ({
            ...props,
            thumbprint: props.thumbprint ?? DEFAULT_GITHUB_THUMBPRINT,
          }))
        : ({
            ...props,
            thumbprint: props.thumbprint ?? DEFAULT_GITHUB_THUMBPRINT,
          } as Input<OIDCProviderProps>),
    );
  }
}
