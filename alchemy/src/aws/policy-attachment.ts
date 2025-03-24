import {
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import type { Context } from "../context";
import { ignore } from "../error";
import { output } from "../output";
import { Resource } from "../resource";

// PolicyAttachment resource
export interface PolicyAttachmentProps {
  policyArn: string;
  roleName: string;
}

export interface PolicyAttachment
  extends Resource<"iam::PolicyAttachment">,
    PolicyAttachmentProps {}

export const PolicyAttachment = Resource(
  "iam::PolicyAttachment",
  async function (
    this: Context<PolicyAttachment> | void,
    id: string,
    props: PolicyAttachmentProps,
  ) {
    return output(id, async (): Promise<PolicyAttachment> => {
      const client = new IAMClient({});

      if (this!.event === "delete") {
        await ignore(NoSuchEntityException.name, () =>
          client.send(
            new DetachRolePolicyCommand({
              PolicyArn: props.policyArn,
              RoleName: props.roleName,
            }),
          ),
        );
        return this!.destroy();
      } else {
        await client.send(
          new AttachRolePolicyCommand({
            PolicyArn: props.policyArn,
            RoleName: props.roleName,
          }),
        );
      }

      return {
        kind: "iam::PolicyAttachment",
        ...props,
      };
    });
  },
);
