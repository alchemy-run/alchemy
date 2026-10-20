import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import MicrovmEgressSandboxLive from "./box.runtime.ts";
import { MicrovmSandboxGateway } from "./gateway.ts";
import MicrovmSandboxGatewayWeb from "./gateway.web.ts";
import MicrovmSandboxWorker from "./worker.ts";

export const providers = Layer.mergeAll(
  AWS.providers(),
  Cloudflare.providers(),
  GitHub.providers({ baseUrl: "github.com" }),
);
export const state = Alchemy.localState();

/**
 * A Cloudflare Worker + Durable Object that owns a sandbox on AWS Lambda
 * MicroVMs, granted GitHub egress through a gateway on a Lambda Web Function.
 */
export default Alchemy.Stack(
  "MicrovmSandboxStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* MicrovmSandboxWorker;
    return { url: worker.url.as<string>() };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MicrovmEgressSandboxLive,
        MicrovmSandboxGateway.host(MicrovmSandboxGatewayWeb),
      ),
    ),
  ),
);
