import * as AWS from "@/AWS";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import {
  DeregisterTargets,
  DeregisterTargetsHttp,
  DescribeCapacityReservation,
  DescribeCapacityReservationHttp,
  DescribeTargetHealth,
  DescribeTargetHealthHttp,
  LoadBalancer,
  ModifyCapacityReservation,
  ModifyCapacityReservationHttp,
  RegisterTargets,
  RegisterTargetsHttp,
  TargetGroup,
} from "@/AWS/ELBv2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * An RFC1918 IP outside the default VPC's CIDR. RegisterTargets accepts
 * out-of-VPC private addresses when `AvailabilityZone: "all"` is specified —
 * no live target is needed (this TG isn't attached to a listener, so the
 * health state is `unused`).
 */
export const testTargetIp = "192.168.100.10";

export class ElbBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ElbBindingsFunction",
) {}

/**
 * Shared fleet for the bindings E2E: an unattached `ip` target group (targets
 * register/deregister without a listener) plus an internal ALB for the
 * capacity-reservation bindings. VPC/subnets are resolved only at deploy
 * time — at runtime the resources resolve to references, so the lookups are
 * guarded off inside the deployed Lambda.
 */
export class BindingsFleet extends Context.Service<
  BindingsFleet,
  { targetGroup: TargetGroup; loadBalancer: LoadBalancer }
>()("ELBv2BindingsFleet") {}

export const BindingsFleetLive = Layer.effect(
  BindingsFleet,
  Effect.gen(function* () {
    const isDeploy = !globalThis.__ALCHEMY_RUNTIME__;
    const vpcId = isDeploy
      ? yield* ec2
          .describeVpcs({
            Filters: [{ Name: "isDefault", Values: ["true"] }],
          })
          .pipe(
            Effect.map((r) => r.Vpcs?.[0]?.VpcId ?? "vpc-0"),
            // Deploy-time lookup only; a failure here is a fixture defect, not
            // a typed error the Function impl contract can carry.
            Effect.orDie,
          )
      : "vpc-0";
    const subnetIds = isDeploy
      ? yield* ec2
          .describeSubnets({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "default-for-az", Values: ["true"] },
            ],
          })
          .pipe(
            Effect.map((r) =>
              (r.Subnets ?? [])
                .flatMap((s) => (s.SubnetId ? [s.SubnetId as SubnetId] : []))
                .slice(0, 2),
            ),
            Effect.orDie,
          )
      : (["subnet-0", "subnet-1"] as SubnetId[]);

    const targetGroup = yield* TargetGroup("ElbBindingsTg", {
      vpcId,
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
    });
    const loadBalancer = yield* LoadBalancer("ElbBindingsLb", {
      type: "application",
      scheme: "internal",
      subnets: subnetIds,
    });
    return { targetGroup, loadBalancer };
  }),
);

export default ElbBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { targetGroup, loadBalancer } = yield* BindingsFleet;

    const registerTargets = yield* RegisterTargets(targetGroup);
    const deregisterTargets = yield* DeregisterTargets(targetGroup);
    const describeTargetHealth = yield* DescribeTargetHealth(targetGroup);
    const describeCapacityReservation =
      yield* DescribeCapacityReservation(loadBalancer);
    const modifyCapacityReservation =
      yield* ModifyCapacityReservation(loadBalancer);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/register") {
          const result = yield* registerTargets({
            Targets: [{ Id: testTargetIp, Port: 80, AvailabilityZone: "all" }],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            message:
              result._tag === "Failure" ? String(result.failure) : undefined,
          });
        }

        if (request.method === "GET" && pathname === "/target-health") {
          const result = yield* describeTargetHealth({}).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            targets:
              result._tag === "Success"
                ? (result.success.TargetHealthDescriptions ?? []).map((d) => ({
                    id: d.Target?.Id,
                    state: d.TargetHealth?.State,
                  }))
                : undefined,
          });
        }

        if (request.method === "POST" && pathname === "/deregister") {
          const result = yield* deregisterTargets({
            Targets: [{ Id: testTargetIp, Port: 80, AvailabilityZone: "all" }],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        if (request.method === "GET" && pathname === "/capacity") {
          const result = yield* describeCapacityReservation().pipe(
            Effect.result,
          );
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
            states:
              result._tag === "Success"
                ? (result.success.CapacityReservationState ?? []).map(
                    (s) => s.State,
                  )
                : undefined,
          });
        }

        // Resets a reservation that was never set — a no-op that proves the
        // write grant end-to-end without reserving billable LCUs.
        if (request.method === "POST" && pathname === "/capacity-reset") {
          const result = yield* modifyCapacityReservation({
            ResetCapacityReservation: true,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            tag: result._tag === "Failure" ? result.failure._tag : "Success",
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RegisterTargetsHttp,
        DeregisterTargetsHttp,
        DescribeTargetHealthHttp,
        DescribeCapacityReservationHttp,
        ModifyCapacityReservationHttp,
        BindingsFleetLive,
      ),
    ),
  ),
);
