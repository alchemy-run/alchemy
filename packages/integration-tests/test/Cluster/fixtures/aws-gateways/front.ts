/**
 * The gateways suite's front: a Lambda function in the suite's VPC, so it
 * reaches the internal gateway, and out through the NAT gateway to the
 * others. Each route calls one pool's waiter and reports what it got.
 */
import * as EC2 from "@alchemy.run/aws/EC2";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { AppNetwork } from "./network.ts";
import { EdgeWaiters, PrivateWaiters, SecureWaiters } from "./waiter.ts";

export default class Front extends Lambda.Function<Front>()(
  "ClusterGatewaysFront",
  Effect.gen(function* () {
    const network = yield* AppNetwork;
    const group = yield* EC2.SecurityGroup("ClusterGatewaysFrontGroup", {
      vpcId: network.vpcId,
      description: "The gateways suite's front",
      egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
    });
    return {
      main: import.meta.url,
      functionUrl: true,
      // Long calls run for minutes.
      timeout: Duration.minutes(5),
      vpc: { subnetIds: network.privateSubnetIds, securityGroupIds: [group.groupId] },
    };
  }),
  Effect.gen(function* () {
    const pools = {
      private: yield* PrivateWaiters,
      edge: yield* EdgeWaiters,
      secure: yield* SecureWaiters,
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [pool, route, a = "0", b = "0"] = url.pathname.split("/").filter((s) => s.length > 0);
        const waiters = pools[pool as keyof typeof pools];
        if (waiters === undefined) return HttpServerResponse.text("ok");
        const waiter = yield* waiters.getByName(url.searchParams.get("id") ?? "w");
        const started = yield* Clock.currentTimeMillis;
        const value =
          route === "sleep"
            ? yield* waiter.Sleep({ seconds: Number(a) })
            : [
                ...(yield* Stream.runCollect(
                  waiter.Drip({ count: Number(a), gapSeconds: Number(b) }),
                )),
              ];
        const elapsedMs = (yield* Clock.currentTimeMillis) - started;
        return yield* HttpServerResponse.json({ value, elapsedMs });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }),
) {}
