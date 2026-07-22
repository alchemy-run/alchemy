import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HyperPodEksInfra } from "./eks-infra.ts";

/**
 * The HIGH-LEVEL tier: an effectful `AWS.EKS.Job` running ON HyperPod
 * nodes. The Effect program is bundled into a generated image
 * (`main: import.meta.url`), and `hyperpodScheduling` pins it to the
 * `workers` instance group on health-checked nodes.
 *
 * Swap `run` for a real training/eval harness; bindings (DynamoDB, S3, SQS,
 * ...) resolve in init and land IAM on the pod-identity role, exactly like
 * any other EKS Job.
 */
export default AWS.EKS.Job(
  "TrainJob",
  Effect.gen(function* () {
    const { eks } = yield* HyperPodEksInfra;
    const scheduling = AWS.SageMaker.hyperpodScheduling({
      instanceGroup: "workers",
    });
    return {
      cluster: eks,
      main: import.meta.url,
      labels: scheduling.labels,
      podTemplate: scheduling.podTemplate,
      backoffLimit: 2,
    };
  }),
  Effect.gen(function* () {
    return {
      run: Effect.gen(function* () {
        yield* Effect.log("training step running on a HyperPod node");
      }),
    };
  }),
);
