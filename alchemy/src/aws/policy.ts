import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DetachRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import { ignore } from "../error";
import { Resource } from "../resource";

// Type-safe policy document types
export type Effect = "Allow" | "Deny";

export interface PolicyStatement {
  Sid?: string;
  Effect: Effect;
  Action: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
  Principal?: Record<string, string | string[]>;
  NotPrincipal?: Record<string, string | string[]>;
  NotAction?: string | string[];
  NotResource?: string | string[];
}

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

// Policy resource
export interface PolicyProps {
  policyName: string;
  document: PolicyDocument;
  description?: string;
  path?: string;
  tags?: Record<string, string>;
}

export interface PolicyOutput extends PolicyProps {
  id: string; // Same as policyName
  arn: string;
  defaultVersionId: string;
  attachmentCount: number;
  createDate: Date;
  updateDate: Date;
  isAttachable: boolean;
}

export class Policy extends Resource(
  "iam::Policy",
  async (ctx, props: PolicyProps): Promise<PolicyOutput> => {
    const client = new IAMClient({});
    const policyArn = `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:policy${props.path || "/"}${props.policyName}`;

    if (ctx.event === "delete") {
      try {
        // List and delete all non-default versions first
        const versions = await client.send(
          new ListPolicyVersionsCommand({
            PolicyArn: policyArn,
          }),
        );

        for (const version of versions.Versions || []) {
          if (!version.IsDefaultVersion) {
            await client.send(
              new DeletePolicyVersionCommand({
                PolicyArn: policyArn,
                VersionId: version.VersionId,
              }),
            );
          }
        }

        // Delete the policy
        await client.send(
          new DeletePolicyCommand({
            PolicyArn: policyArn,
          }),
        );
      } catch (error: any) {
        if (error.name !== NoSuchEntityException.name) {
          throw error;
        }
      }
      return {
        ...props,
        id: props.policyName,
        arn: policyArn,
        defaultVersionId: "v1",
        attachmentCount: 0,
        createDate: new Date(),
        updateDate: new Date(),
        isAttachable: true,
      };
    } else {
      try {
        // Check if policy exists
        const existingPolicy = await client.send(
          new GetPolicyCommand({
            PolicyArn: policyArn,
          }),
        );

        // Get current policy version
        const currentVersion = await client.send(
          new GetPolicyVersionCommand({
            PolicyArn: policyArn,
            VersionId: existingPolicy.Policy!.DefaultVersionId!,
          }),
        );

        const currentDocument = JSON.parse(
          decodeURIComponent(currentVersion.PolicyVersion!.Document!),
        );

        // If policy document changed, create new version
        if (
          JSON.stringify(currentDocument) !== JSON.stringify(props.document)
        ) {
          // List versions to check if we need to delete old ones
          const versions = await client.send(
            new ListPolicyVersionsCommand({
              PolicyArn: policyArn,
            }),
          );

          // Delete oldest version if we have 5 versions (maximum allowed)
          if (versions.Versions?.length === 5) {
            const oldestVersion = versions.Versions.sort(
              (a, b) => a.CreateDate!.getTime() - b.CreateDate!.getTime(),
            )[0];

            if (!oldestVersion.IsDefaultVersion) {
              await client.send(
                new DeletePolicyVersionCommand({
                  PolicyArn: policyArn,
                  VersionId: oldestVersion.VersionId!,
                }),
              );
            }
          }

          // Create new version
          await client.send(
            new CreatePolicyVersionCommand({
              PolicyArn: policyArn,
              PolicyDocument: JSON.stringify(props.document),
              SetAsDefault: true,
            }),
          );
        }

        const policy = await client.send(
          new GetPolicyCommand({
            PolicyArn: policyArn,
          }),
        );

        return {
          ...props,
          id: props.policyName,
          arn: policy.Policy!.Arn!,
          defaultVersionId: policy.Policy!.DefaultVersionId!,
          attachmentCount: policy.Policy!.AttachmentCount!,
          createDate: policy.Policy!.CreateDate!,
          updateDate: policy.Policy!.UpdateDate!,
          isAttachable: policy.Policy!.IsAttachable!,
        };
      } catch (error: any) {
        if (error.name === "NoSuchEntity") {
          // Create new policy
          const newPolicy = await client.send(
            new CreatePolicyCommand({
              PolicyName: props.policyName,
              PolicyDocument: JSON.stringify(props.document),
              Description: props.description,
              Path: props.path,
              Tags: props.tags
                ? Object.entries(props.tags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  }))
                : undefined,
            }),
          );

          return {
            ...props,
            id: props.policyName,
            arn: newPolicy.Policy!.Arn!,
            defaultVersionId: newPolicy.Policy!.DefaultVersionId!,
            attachmentCount: newPolicy.Policy!.AttachmentCount!,
            createDate: newPolicy.Policy!.CreateDate!,
            updateDate: newPolicy.Policy!.UpdateDate!,
            isAttachable: newPolicy.Policy!.IsAttachable!,
          };
        }
        throw error;
      }
    }
  },
) {}

// PolicyAttachment resource
export interface PolicyAttachmentProps {
  policyArn: string;
  roleName: string;
}

export interface PolicyAttachmentOutput extends PolicyAttachmentProps {}

export class PolicyAttachment extends Resource(
  "iam::PolicyAttachment",
  async (ctx, props: PolicyAttachmentProps) => {
    const client = new IAMClient({});

    if (ctx.event === "delete") {
      await ignore(NoSuchEntityException.name, () =>
        client.send(
          new DetachRolePolicyCommand({
            PolicyArn: props.policyArn,
            RoleName: props.roleName,
          }),
        ),
      );
    } else {
      await client.send(
        new AttachRolePolicyCommand({
          PolicyArn: props.policyArn,
          RoleName: props.roleName,
        }),
      );
    }

    return props;
  },
) {}
