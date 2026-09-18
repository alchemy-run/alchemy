import * as Effect from "effect/Effect";
import * as EC2 from "../AWS/EC2/index.ts";
import * as ELBv2 from "../AWS/ELBv2/index.ts";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import {
  CELLD_HEALTH_PATH,
  CELLD_INTERNAL_PORT,
  CELLD_PUBLIC_PORT,
} from "./CelldCli.ts";
import { makeEcsNodeIngress } from "./EcsHostConfig.ts";

/** Instance targets give host-network tasks ordinary HTTP URLs without SRV clients. */
export const composeEcsPrivateIngress = (options: {
  readonly vpcId: Input<EC2.VpcId>;
  readonly subnetIds: Input<EC2.SubnetId[]>;
  readonly callerGroupId: Input<EC2.SecurityGroupId>;
  readonly managementGroupId: Input<EC2.SecurityGroupId>;
  readonly nodeGroupId: Input<EC2.SecurityGroupId>;
  readonly existingCallers?: string[];
  readonly tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const securityGroup = yield* EC2.SecurityGroup(
      "PrivateIngressSecurityGroup",
      {
        vpcId: options.vpcId,
        description: "Celld private Worker and management ingress",
        ingress: makeEcsNodeIngress(
          options.callerGroupId,
          options.managementGroupId,
          options.existingCallers,
        ),
        tags: options.tags,
      },
    );
    const loadBalancer = yield* ELBv2.LoadBalancer("PrivateIngress", {
      type: "network",
      scheme: "internal",
      subnets: options.subnetIds,
      securityGroups: [securityGroup.groupId],
      attributes: { "load_balancing.cross_zone.enabled": "true" },
      tags: options.tags,
    });
    const loadBalancers = [];
    for (const port of [CELLD_PUBLIC_PORT, CELLD_INTERNAL_PORT]) {
      yield* EC2.SecurityGroupRule(`PrivateIngressFromNodes${port}`, {
        groupId: securityGroup.groupId,
        type: "ingress",
        ipProtocol: "tcp",
        fromPort: port,
        toPort: port,
        referencedGroupId: options.nodeGroupId,
        tags: options.tags,
      });
      const rule = yield* EC2.SecurityGroupRule(
        `PrivateIngressToNodes${port}`,
        {
          groupId: options.nodeGroupId,
          type: "ingress",
          ipProtocol: "tcp",
          fromPort: port,
          toPort: port,
          referencedGroupId: securityGroup.groupId,
          tags: options.tags,
        },
      );
      const target = yield* ELBv2.TargetGroup(`PrivateTarget${port}`, {
        vpcId: options.vpcId,
        port,
        protocol: "TCP",
        targetType: "instance",
        healthCheckProtocol: "HTTP",
        healthCheckPath: CELLD_HEALTH_PATH,
        healthCheckPort: String(CELLD_PUBLIC_PORT),
        healthCheckInterval: "10 seconds",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        attributes: {
          "deregistration_delay.timeout_seconds": "120",
          // Nodes can call the fleet URL and be selected as their own target.
          "preserve_client_ip.enabled": "false",
        },
        tags: options.tags,
      });
      const listener = yield* ELBv2.Listener(`PrivateListener${port}`, {
        loadBalancerArn: loadBalancer.loadBalancerArn,
        port,
        protocol: "TCP",
        targetGroupArn: target.targetGroupArn,
      });
      loadBalancers.push({
        targetGroupArn: Output.all(
          target.targetGroupArn,
          listener.listenerArn,
          rule.securityGroupRuleId,
        ).pipe(Output.map(([arn]) => arn)),
        containerName: "celld",
        containerPort: port,
      });
    }
    return {
      loadBalancers,
      fleetUrl: Output.interpolate`http://${loadBalancer.dnsName}:${String(CELLD_PUBLIC_PORT)}`,
      managementUrl: Output.interpolate`http://${loadBalancer.dnsName}:${String(CELLD_INTERNAL_PORT)}`,
    };
  });
