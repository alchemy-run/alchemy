import { AWS } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Network, NetworkLive } from "./Network.ts";
import ServerInstance from "./ServerInstance.ts";

const WebFleet = Effect.gen(function* () {
  const network = yield* Network;
  const launchTemplate = yield* ServerInstance;

  const alb = yield* AWS.ELBv2.LoadBalancer("ApplicationLoadBalancer", {
    type: "application",
    scheme: "internet-facing",
    subnets: network.publicSubnetIds,
    securityGroups: [network.albSecurityGroupId],
  });

  const albTargetGroup = yield* AWS.ELBv2.TargetGroup(
    "ApplicationTargetGroup",
    {
      vpcId: network.network.vpcId,
      port: 3000,
      protocol: "HTTP",
      targetType: "instance",
      healthCheckPath: "/",
    },
  );

  yield* AWS.ELBv2.Listener("ApplicationListener", {
    loadBalancerArn: alb.loadBalancerArn,
    targetGroupArn: albTargetGroup.targetGroupArn,
    port: 80,
    protocol: "HTTP",
  });

  const nlb = yield* AWS.ELBv2.LoadBalancer("NetworkLoadBalancer", {
    type: "network",
    scheme: "internet-facing",
    subnets: network.publicSubnetIds,
    securityGroups: [network.nlbSecurityGroupId],
  });

  const nlbTargetGroup = yield* AWS.ELBv2.TargetGroup("NetworkTargetGroup", {
    vpcId: network.network.vpcId,
    port: 3000,
    protocol: "TCP",
    targetType: "instance",
  });

  yield* AWS.ELBv2.Listener("NetworkListener", {
    loadBalancerArn: nlb.loadBalancerArn,
    targetGroupArn: nlbTargetGroup.targetGroupArn,
    port: 80,
    protocol: "TCP",
  });

  const autoScalingGroup = yield* AWS.AutoScaling.AutoScalingGroup(
    "ServerFleet",
    {
      launchTemplate,
      subnetIds: network.privateSubnetIds,
      minSize: 2,
      maxSize: 4,
      desiredCapacity: 2,
      targetGroupArns: [
        albTargetGroup.targetGroupArn,
        nlbTargetGroup.targetGroupArn,
      ],
      healthCheckType: "ELB",
      healthCheckGracePeriod: 120,
    },
  );

  yield* AWS.AutoScaling.ScalingPolicy("ServerCpuScaling", {
    autoScalingGroup,
    predefinedMetricType: "ASGAverageCPUUtilization",
    targetValue: 60,
    estimatedInstanceWarmup: 120,
  });

  return {
    albDnsName: alb.dnsName,
    nlbDnsName: nlb.dnsName,
    autoScalingGroupName: autoScalingGroup.autoScalingGroupName,
  };
}).pipe(Effect.provide(Layer.mergeAll(NetworkLive)));

export default WebFleet;
