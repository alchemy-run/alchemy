import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { awsApp, AwsGateway } from "../../conformance/aws-app.ts";

export const GatewayBuildRole = AWS.IAM.Role("GatewayMicrovmBuildRole");

/** The AWS conformance program as a Lambda MicroVM image. */
export class GatewayedMicrovm extends AWS.Lambda.MicrovmImage<GatewayedMicrovm>()(
  "GatewayedMicrovm",
) {}

export default GatewayedMicrovm.make(
  GatewayBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" as const }],
    })),
  ),
  awsApp.pipe(Effect.provide(AwsGateway)),
);
