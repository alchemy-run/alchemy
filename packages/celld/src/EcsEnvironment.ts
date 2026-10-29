import { AwsAuth } from "@alchemy.run/aws/AuthProvider";
import * as AwsCredentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { Default as DefaultEnvironment } from "@alchemy.run/aws/Environment";
import * as AwsRegion from "@alchemy.run/aws/Region";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Layer from "effect/Layer";

/** The deploying identity's AWS region, credentials and endpoint, as the ECS host's layers use them. */
export const ecsAwsEnvironment = Layer.mergeAll(
  AwsRegion.fromEnvironment,
  AwsCredentials.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);
