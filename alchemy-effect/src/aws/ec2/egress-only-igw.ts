import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";
import type { VpcId } from "./vpc.ts";

export const EgressOnlyInternetGateway = Resource<{
  <const ID extends string, const Props extends EgressOnlyInternetGatewayProps>(
    id: ID,
    props: Props,
  ): EgressOnlyInternetGateway<ID, Props>;
}>("AWS.EC2.EgressOnlyInternetGateway");

export interface EgressOnlyInternetGateway<
  ID extends string = string,
  Props extends EgressOnlyInternetGatewayProps = EgressOnlyInternetGatewayProps,
> extends Resource<
  "AWS.EC2.EgressOnlyInternetGateway",
  ID,
  Props,
  EgressOnlyInternetGatewayAttrs<Input.Resolve<Props>>,
  EgressOnlyInternetGateway
> {}

export type EgressOnlyInternetGatewayId<ID extends string = string> =
  `eigw-${ID}`;
export const EgressOnlyInternetGatewayId = <ID extends string>(
  id: ID,
): ID & EgressOnlyInternetGatewayId<ID> =>
  `eigw-${id}` as ID & EgressOnlyInternetGatewayId<ID>;

export type EgressOnlyInternetGatewayArn<
  ID extends EgressOnlyInternetGatewayId = EgressOnlyInternetGatewayId,
> = `arn:aws:ec2:${RegionID}:${AccountID}:egress-only-internet-gateway/${ID}`;

export interface EgressOnlyInternetGatewayProps {
  /**
   * The VPC for which to create the egress-only internet gateway.
   */
  vpcId: Input<VpcId>;

  /**
   * Tags to assign to the egress-only internet gateway.
   */
  tags?: Record<string, Input<string>>;
}

export interface EgressOnlyInternetGatewayAttrs<
  Props extends Input.Resolve<EgressOnlyInternetGatewayProps> =
    Input.Resolve<EgressOnlyInternetGatewayProps>,
> {
  /**
   * The ID of the egress-only internet gateway.
   */
  egressOnlyInternetGatewayId: EgressOnlyInternetGatewayId;

  /**
   * The Amazon Resource Name (ARN) of the egress-only internet gateway.
   */
  egressOnlyInternetGatewayArn: EgressOnlyInternetGatewayArn<
    this["egressOnlyInternetGatewayId"]
  >;

  /**
   * Information about the attachment of the egress-only internet gateway.
   */
  attachments?: Array<{
    /**
     * The current state of the attachment.
     */
    state: "attaching" | "attached" | "detaching" | "detached";
    /**
     * The ID of the VPC.
     */
    vpcId: Props["vpcId"];
  }>;
}
