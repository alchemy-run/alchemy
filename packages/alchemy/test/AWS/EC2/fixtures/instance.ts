import * as AWS from "@/AWS";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * End-to-end fixture for a hosted `AWS.EC2.Instance`: a long-running server.
 *
 * The props Effect provisions the networking (a public-subnet VPC) and the
 * instance's security group, then launches the instance into it. The program
 * Effect registers a `ServerHost.run` background loop (the #706 pattern) and
 * returns a `{ fetch }` handler that the instance's Bun HTTP server serves on
 * `port`. `/ticks` reports the loop counter so the test can prove the
 * background loop runs inside the deployed instance.
 */
export default class TestInstance extends AWS.EC2.Instance<TestInstance>()(
  "Ec2E2EInstance",
  Effect.gen(function* () {
    const imageId = yield* AWS.EC2.amazonLinux2023();
    const network = yield* AWS.EC2.Network("Ec2E2ENetwork", {
      cidrBlock: "10.81.0.0/16",
      availabilityZones: 1,
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("Ec2E2ESg", {
      vpcId: network.vpcId,
      description: "alchemy ec2 instance e2e",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
          description: "app",
        },
      ],
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "all outbound",
        },
      ],
    });

    return {
      main: import.meta.filename,
      imageId,
      instanceType: "t3.small",
      subnetId: network.publicSubnetIds[0],
      securityGroupIds: [securityGroup.groupId],
      associatePublicIpAddress: true,
      port: 3000,
      // SSM access so the test can read journalctl / cloud-init logs if the
      // service doesn't come up (the systemd unit logs to journald, not
      // CloudWatch).
      roleManagedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      ],
    };
  }),
  Effect.gen(function* () {
    const host = yield* ServerHost;
    const ticks = yield* Ref.make(0);

    // Long-running background loop (the `host.run` pattern from #706).
    yield* host.run(
      Ref.update(ticks, (n) => n + 1).pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://instance");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/ticks") {
          return yield* HttpServerResponse.json({
            ticks: yield* Ref.get(ticks),
          });
        }
        return HttpServerResponse.text("hello from ec2 instance");
      }),
    };
  }),
) {}
