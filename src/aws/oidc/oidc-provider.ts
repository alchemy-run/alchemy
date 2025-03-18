import {
  CreateOpenIDConnectProviderCommand,
  DeleteOpenIDConnectProviderCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  IAMClient,
  type Tag,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { type Context, Resource } from "../../resource";
import { getAccountId } from "../account-id";

/**
 * Properties for configuring an AWS OIDC provider for GitHub Actions
 */
export interface OIDCProviderProps {
  /**
   * The GitHub organization or user that owns the repository
   */
  owner: string;

  /**
   * The name of the GitHub repository
   */
  repository: string;

  /**
   * Optional list of branches to restrict access to
   * If not provided, all branches will be allowed
   */
  branches?: string[];

  /**
   * Optional list of environments to restrict access to
   * If not provided, all environments will be allowed
   */
  environments?: string[];

  /**
   * The ARN of the IAM role to be assumed
   */
  roleArn: string;

  /**
   * Optional maximum session duration in seconds (default: 3600)
   */
  maxSessionDuration?: number;

  /**
   * Thumbprint for the OIDC provider
   */
  thumbprint: string;

  /**
   * Optional AWS region (defaults to AWS_REGION environment variable)
   */
  region?: string;
}

/**
 * Output returned after OIDC provider configuration
 */
export interface OIDCProviderOutput extends OIDCProviderProps {
  /**
   * The ARN of the OIDC provider
   */
  providerArn: string;

  /**
   * Time at which the provider was created
   */
  createdAt: number;
}

/**
 * Unique identifier for our trust policy statement
 * Used to track and remove our specific statement without affecting others
 */
const TRUST_POLICY_SID = "GitHubOIDCTrust";

/**
 * Resource for configuring AWS OIDC provider for GitHub Actions
 */
export class OIDCProvider extends Resource(
  "aws::OIDCProvider",
  async (ctx: Context<OIDCProviderOutput>, props: OIDCProviderProps) => {
    // Initialize AWS SDK client
    const client = new IAMClient({
      region: props.region,
    });

    if (ctx.event === "delete") {
      if (ctx.output?.providerArn) {
        try {
          // First, remove our trust policy statement from the role
          const getRole = await client.send(
            new GetRoleCommand({
              RoleName: props.roleArn.split("/").pop(),
            }),
          );

          if (getRole.Role?.AssumeRolePolicyDocument) {
            const policy = JSON.parse(
              decodeURIComponent(getRole.Role.AssumeRolePolicyDocument),
            );

            // Remove our specific statement while preserving others
            policy.Statement = policy.Statement.filter(
              (stmt: any) => stmt.Sid !== TRUST_POLICY_SID,
            );

            await client.send(
              new UpdateAssumeRolePolicyCommand({
                RoleName: props.roleArn.split("/").pop(),
                PolicyDocument: JSON.stringify(policy),
              }),
            );
          }

          // Then delete the OIDC provider if we're the last user
          const provider = await client.send(
            new GetOpenIDConnectProviderCommand({
              OpenIDConnectProviderArn: ctx.output.providerArn,
            }),
          );

          // Only delete the provider if it exists and has no other tags
          if (provider && (!provider.Tags || provider.Tags.length === 0)) {
            await client.send(
              new DeleteOpenIDConnectProviderCommand({
                OpenIDConnectProviderArn: ctx.output.providerArn,
              }),
            );
          }
        } catch (error) {
          // Log but don't throw on cleanup errors
          console.error("Error during cleanup:", error);
        }
      }
      return;
    }

    try {
      const url = "https://token.actions.githubusercontent.com";
      const thumbprint = props.thumbprint;

      // Create or get existing OIDC provider
      let providerArn: string;
      try {
        const createProvider = await client.send(
          new CreateOpenIDConnectProviderCommand({
            Url: url,
            ClientIDList: ["sts.amazonaws.com"],
            ThumbprintList: [thumbprint],
            Tags: [
              {
                Key: "ManagedBy",
                Value: "alchemy",
              },
            ] as Tag[],
          }),
        );
        providerArn = createProvider.OpenIDConnectProviderArn!;
      } catch (error: any) {
        if (error.name === "EntityAlreadyExistsException") {
          // Provider exists, use its ARN
          providerArn = `arn:aws:iam::${await getAccountId()}:oidc-provider/${url}`;
        } else {
          throw error;
        }
      }

      // Get current role policy
      const getRole = await client.send(
        new GetRoleCommand({
          RoleName: props.roleArn.split("/").pop(),
        }),
      );

      let policy: any;
      if (getRole.Role?.AssumeRolePolicyDocument) {
        policy = JSON.parse(
          decodeURIComponent(getRole.Role.AssumeRolePolicyDocument),
        );
      } else {
        policy = {
          Version: "2012-10-17",
          Statement: [],
        };
      }

      // Construct the trust policy conditions
      const conditions: Record<string, any> = {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${props.owner}/${props.repository}:`,
        },
      };

      if (props.branches?.length) {
        conditions.StringEquals["token.actions.githubusercontent.com:sub"] =
          props.branches.map(
            (branch) =>
              `repo:${props.owner}/${props.repository}:ref:refs/heads/${branch}`,
          );
      }

      if (props.environments?.length) {
        conditions.StringEquals["token.actions.githubusercontent.com:sub"] =
          props.environments.map(
            (env) =>
              `repo:${props.owner}/${props.repository}:environment:${env}`,
          );
      }

      // Create our policy statement
      const ourStatement = {
        Sid: TRUST_POLICY_SID,
        Effect: "Allow",
        Principal: {
          Federated: providerArn,
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: conditions,
      };

      // Remove any existing statement with our SID and add the new one
      policy.Statement = [
        ...policy.Statement.filter(
          (stmt: any) => stmt.Sid !== TRUST_POLICY_SID,
        ),
        ourStatement,
      ];

      // Update the role's trust policy
      await client.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: props.roleArn.split("/").pop(),
          PolicyDocument: JSON.stringify(policy),
        }),
      );

      return {
        ...props,
        providerArn,
        createdAt: Date.now(),
      };
    } catch (error) {
      console.error("Error configuring OIDC provider:", error);
      throw error;
    }
  },
) {}
