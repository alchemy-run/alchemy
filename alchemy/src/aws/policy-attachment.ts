import {
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import type { Context } from "../context";
import { Resource } from "../resource";
import { ignore } from "../util/ignore";

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
    this: Context<PolicyAttachment>,
    id: string,
    props: PolicyAttachmentProps,
  ) {
    const client = new IAMClient({});

    if (this.phase === "delete") {
      await ignore(NoSuchEntityException.name, () =>
        client.send(
          new DetachRolePolicyCommand({
            PolicyArn: props.policyArn,
            RoleName: props.roleName,
          }),
        ),
      );
      return this.destroy();
    } else {
      await client.send(
        new AttachRolePolicyCommand({
          PolicyArn: props.policyArn,
          RoleName: props.roleName,
        }),
      );
    }

    return this(props);
  },
);
