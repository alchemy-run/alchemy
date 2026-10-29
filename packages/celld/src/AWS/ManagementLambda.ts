/**
 * The management runner as a VPC Lambda. This module is the Lambda's entry,
 * so it imports only what the runner executes.
 */
import { Function as LambdaFunction } from "@alchemy.run/aws/Lambda/Function";
import { fromEnv } from "@distilled.cloud/aws/Credentials";
import type { InputProps } from "alchemy/Input";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  executeManagementRequest,
  ManagementRunnerHttp,
  managementStorePolicy,
} from "./ManagementRunner.ts";

export interface ManagementLambdaProps {
  /** Dedicated existing fleet backing bucket, without s3://. */
  readonly bucketName: string;
  /** IAM partition for bucket ARNs. @default aws */
  readonly partition?: string;
  /** Private subnets and a management-only security group. */
  readonly vpc: { subnetIds: string[]; securityGroupIds: string[] };
  /** Number of live node sessions required. @default 1 */
  readonly minimumNodes?: number;
}

/** Compose into EcsFleet and persist only its functionArn in hostState.managementFunctionArn. */
export const ManagementLambda = (
  id: string,
  props: InputProps<Omit<ManagementLambdaProps, "partition" | "minimumNodes">> &
    Pick<ManagementLambdaProps, "partition" | "minimumNodes">,
) =>
  Effect.gen(function* () {
    const main = yield* Effect.sync(() => import.meta.url);
    const runner = yield* LambdaFunction(id, {
      main,
      functionUrl: false,
      runtime: "nodejs22.x",
      memorySize: 256,
      timeout: Duration.seconds(75),
      vpc: props.vpc,
      env: {
        CELLD_MANAGEMENT_BUCKET: props.bucketName,
        CELLD_MANAGEMENT_MINIMUM_NODES: String(props.minimumNodes ?? 1),
      },
    });
    yield* runner.bind("CelldManagementStore", {
      policyStatements: managementStorePolicy(props.partition, props.bucketName),
    });
    return runner;
  });

const run = (event: unknown) =>
  executeManagementRequest(event).pipe(
    Effect.provide(Layer.mergeAll(fromEnv(), ManagementRunnerHttp)),
  );

/** Standard Lambda boundary; invocation is authorized by IAM, never an HTTP URL. */
export default (event: unknown) => Effect.runPromise(run(event));
