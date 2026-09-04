import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Server from "./src/Server.ts";

export default Alchemy.Stack(
  "AwsEc2Example",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const instance = yield* Server;

    return {
      instanceId: instance.instanceId,
      publicIpAddress: instance.publicIpAddress,
      // Service-derived URL, not `http://${publicIpAddress}:3000`: in
      // `alchemy dev` the emulator stuffs a host-routed DNS name into
      // the public address fields, and `url` is the only attribute that
      // also carries the process port.
      url: instance.url,
      enqueueUrl: Output.interpolate`${instance.url}/enqueue?message=hello`,
    };
  }),
);
