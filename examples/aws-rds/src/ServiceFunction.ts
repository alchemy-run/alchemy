import { AWS } from "alchemy-effect";
import * as Http from "alchemy-effect/Http";
import type { Input } from "alchemy-effect/Input";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DatabaseAurora } from "./Database.ts";
import { HttpServer } from "./HttpServer.ts";
import { Network, NetworkLive } from "./Network.ts";

export default Effect.gen(function* () {
  const network = yield* Network;

  yield* Http.serve(yield* HttpServer);

  return {
    main: import.meta.path,
    url: true,
    vpc: {
      subnetIds: network.vpc.privateSubnets.map((subnet) => subnet.subnetId),
      securityGroupIds: network.privateSecurityGroups.map(
        (securityGroup) => securityGroup.groupId,
      ),
    },
  } satisfies Input<AWS.Lambda.FunctionProps>;
}).pipe(
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(DatabaseAurora, AWS.Lambda.HttpServer),
      Layer.mergeAll(NetworkLive, AWS.RDS.ConnectLive),
    ),
  ),
  AWS.Lambda.Function("ServiceFunction"),
);
