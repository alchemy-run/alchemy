import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  EntityAlreadyExistsException,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
  PutRolePolicyCommand,
  type Tag,
  TagRoleCommand,
  UpdateAssumeRolePolicyCommand,
  UpdateRoleCommand,
} from "@aws-sdk/client-iam";
import type { Context } from "../context";
import { Resource } from "../resource";
import { ignore } from "../util/ignore";
import type { PolicyDocument } from "./policy";

export interface RoleProps {
  roleName: string;
  assumeRolePolicy: PolicyDocument;
  description?: string;
  path?: string;
  maxSessionDuration?: number;
  permissionsBoundary?: string;
  policies?: Array<{
    policyName: string;
    policyDocument: PolicyDocument;
  }>;
  managedPolicyArns?: string[];
  tags?: Record<string, string>;
}

export interface Role extends Resource<"iam::Role">, RoleProps {
  arn: string;
  uniqueId: string; // Unique identifier for the role
  roleId: string; // The stable and unique string identifying the role
  createDate: Date;
}

export const Role = Resource(
  "iam::Role",
  async function (
    this: Context<Role>,
    id: string,
    props: RoleProps,
  ): Promise<Role> {
    const client = new IAMClient({});

    if (this.phase === "delete") {
      // Delete any inline policies first
      if (props.policies) {
        for (const policy of props.policies) {
          await ignore(NoSuchEntityException.name, () =>
            client.send(
              new DeleteRolePolicyCommand({
                RoleName: props.roleName,
                PolicyName: policy.policyName,
              }),
            ),
          );
        }
      }

      // We need to detach managed policies before deleting the role
      // First, get all attached policies
      try {
        const attachedPoliciesResponse = await client.send(
          new ListAttachedRolePoliciesCommand({
            RoleName: props.roleName,
          }),
        );

        // Detach all managed policies
        const attachedPolicies =
          attachedPoliciesResponse.AttachedPolicies || [];
        for (const policy of attachedPolicies) {
          await client.send(
            new DetachRolePolicyCommand({
              RoleName: props.roleName,
              PolicyArn: policy.PolicyArn!,
            }),
          );
        }
      } catch (error: any) {
        if (error.name !== NoSuchEntityException.name) {
          throw error;
        }
      }

      await ignore(NoSuchEntityException.name, () =>
        client.send(
          new DeleteRoleCommand({
            RoleName: props.roleName,
          }),
        ),
      );
      return this.destroy();
    }

    const assumeRolePolicyDocument = JSON.stringify(props.assumeRolePolicy);
    let role;

    try {
      if (this.phase === "create") {
        // Try to create the role
        await client.send(
          new CreateRoleCommand({
            RoleName: props.roleName,
            AssumeRolePolicyDocument: assumeRolePolicyDocument,
            Description: props.description,
            Path: props.path,
            MaxSessionDuration: props.maxSessionDuration,
            PermissionsBoundary: props.permissionsBoundary,
            Tags: [
              ...Object.entries(props.tags || {}).map(([Key, Value]) => ({
                Key,
                Value,
              })),
              {
                Key: "alchemy_stage",
                Value: this.stage,
              },
              {
                Key: "alchemy_resource",
                Value: this.id,
              },
            ],
          }),
        );
      }
    } catch (error: any) {
      if (
        error instanceof EntityAlreadyExistsException &&
        this.phase === "create"
      ) {
        // Check if we were the ones who created it
        const existingRole = await client.send(
          new GetRoleCommand({
            RoleName: props.roleName,
          }),
        );
        const roleTags =
          existingRole.Role?.Tags?.reduce(
            (acc, tag) => {
              acc[tag.Key!] = tag.Value!;
              return acc;
            },
            {} as Record<string, string>,
          ) || {};

        if (
          roleTags.alchemy_stage !== this.stage ||
          roleTags.alchemy_resource !== this.id
        ) {
          throw error;
        }
      } else if (error.name !== NoSuchEntityException.name) {
        throw error;
      }
    }

    // Get or update the role
    role = await client.send(
      new GetRoleCommand({
        RoleName: props.roleName,
      }),
    );

    // Update assume role policy if it changed
    if (role.Role?.AssumeRolePolicyDocument !== assumeRolePolicyDocument) {
      await client.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: props.roleName,
          PolicyDocument: assumeRolePolicyDocument,
        }),
      );
    }

    // Update role description and max session duration if they changed
    if (
      role.Role?.Description !== props.description ||
      role.Role?.MaxSessionDuration !== props.maxSessionDuration
    ) {
      await client.send(
        new UpdateRoleCommand({
          RoleName: props.roleName,
          Description: props.description,
          MaxSessionDuration: props.maxSessionDuration,
        }),
      );
    }

    // Update tags
    const newTags = {
      ...props.tags,
      alchemy_stage: this.stage,
      alchemy_resource: this.id,
    };
    const tags: Tag[] = Object.entries(newTags).map(([Key, Value]) => ({
      Key,
      Value,
    }));
    await client.send(
      new TagRoleCommand({
        RoleName: props.roleName,
        Tags: tags,
      }),
    );

    // Handle policy changes
    const previousPolicies =
      this.phase === "update" ? this.output!.policies || [] : [];
    const currentPolicies = props.policies || [];

    // Delete policies that were removed
    for (const oldPolicy of previousPolicies) {
      if (
        !currentPolicies.some(
          (p: { policyName: string }) => p.policyName === oldPolicy.policyName,
        )
      ) {
        await ignore(NoSuchEntityException.name, () =>
          client.send(
            new DeleteRolePolicyCommand({
              RoleName: props.roleName,
              PolicyName: oldPolicy.policyName,
            }),
          ),
        );
      }
    }

    // Update or create policies
    for (const policy of currentPolicies) {
      const oldPolicy = previousPolicies.find(
        (p) => p.policyName === policy.policyName,
      );
      if (
        !oldPolicy ||
        JSON.stringify(oldPolicy.policyDocument) !==
          JSON.stringify(policy.policyDocument)
      ) {
        await client.send(
          new PutRolePolicyCommand({
            RoleName: props.roleName,
            PolicyName: policy.policyName,
            PolicyDocument: JSON.stringify(policy.policyDocument),
          }),
        );
      }
    }

    // Handle managed policy attachments
    // Get currently attached policies
    const attachedPoliciesResponse = await client.send(
      new ListAttachedRolePoliciesCommand({
        RoleName: props.roleName,
      }),
    );

    const currentAttachedPolicies =
      attachedPoliciesResponse.AttachedPolicies || [];
    const currentPolicyArns = currentAttachedPolicies.map((p) => p.PolicyArn!);

    // If we're updating, use an empty array as default when managedPolicyArns is undefined
    // to ensure we detach all managed policies
    const desiredPolicyArns = props.managedPolicyArns || [];

    // Detach policies that are no longer needed
    for (const policyArn of currentPolicyArns) {
      if (!desiredPolicyArns.includes(policyArn)) {
        await client.send(
          new DetachRolePolicyCommand({
            RoleName: props.roleName,
            PolicyArn: policyArn,
          }),
        );
      }
    }

    // Attach new policies that weren't attached before
    for (const policyArn of desiredPolicyArns) {
      if (!currentPolicyArns.includes(policyArn)) {
        await client.send(
          new AttachRolePolicyCommand({
            RoleName: props.roleName,
            PolicyArn: policyArn,
          }),
        );
      }
    }

    if (!role?.Role) {
      throw new Error(`Failed to create or update role ${props.roleName}`);
    }

    return this({
      ...props,
      arn: role.Role.Arn!,
      uniqueId: role.Role.RoleId!,
      roleId: role.Role.RoleId!,
      roleName: role.Role.RoleName ?? props.roleName,
      createDate: role.Role.CreateDate!,
    });
  },
);
