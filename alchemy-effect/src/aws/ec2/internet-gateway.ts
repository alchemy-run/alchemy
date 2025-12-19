import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const InternetGateway = Resource<{
  <const ID extends string, const Props extends InternetGatewayProps>(
    id: ID,
    props: Props,
  ): InternetGateway<ID, Props>;
}>("AWS.EC2.InternetGateway");

export interface InternetGateway<
  ID extends string = string,
  Props extends InternetGatewayProps = InternetGatewayProps,
> extends Resource<
  "AWS.EC2.InternetGateway",
  ID,
  Props,
  InternetGatewayAttrs<Input.Resolve<Props>>,
  InternetGateway
> {}

export type InternetGatewayId<ID extends string = string> = `igw-${ID}`;
export const InternetGatewayId = <ID extends string>(
  id: ID,
): ID & InternetGatewayId<ID> => `igw-${id}` as ID & InternetGatewayId<ID>;

export interface InternetGatewayProps {
  /**
   * The VPC to attach the internet gateway to.
   * If provided, the internet gateway will be automatically attached to the VPC.
   * Optional - you can create an unattached internet gateway and attach it later.
   */
  vpcId?: Input<VpcId>;

  /**
   * Tags to assign to the internet gateway.
   * These will be merged with alchemy auto-tags (alchemy::app, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, Input<string>>;
}

export interface InternetGatewayAttrs<Props extends InternetGatewayProps> {
  /**
   * The ID of the internet gateway.
   */
  internetGatewayId: InternetGatewayId;

  /**
   * The Amazon Resource Name (ARN) of the internet gateway.
   */
  internetGatewayArn: `arn:aws:ec2:${RegionID}:${AccountID}:internet-gateway/${this["internetGatewayId"]}`;

  /**
   * The ID of the VPC the internet gateway is attached to (if any).
   */
  vpcId?: Props["vpcId"];

  /**
   * The ID of the AWS account that owns the internet gateway.
   */
  ownerId?: string;

  /**
   * The attachments for the internet gateway.
   */
  attachments?: Array<{
    /**
     * The current state of the attachment.
     */
    state: "attaching" | "available" | "detaching" | "detached";
    /**
     * The ID of the VPC.
     */
    vpcId: string;
  }>;
}
