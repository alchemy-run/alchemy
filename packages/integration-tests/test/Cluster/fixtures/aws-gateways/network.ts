/** The suite's own VPC: private subnets behind one NAT gateway. */
import * as EC2 from "@alchemy.run/aws/EC2";

export const AppNetwork = EC2.Network("ClusterGatewaysNetwork", {
  cidrBlock: "10.45.0.0/16",
  availabilityZones: 2,
  nat: "single",
});
