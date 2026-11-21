/** Out-of-band reads of what the Rivet AWS hosts deployed, through distilled. */
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as tagging from "@distilled.cloud/aws/resource-groups-tagging-api";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

type StackRef = { readonly name: string; readonly stage: string };

/** ARNs of the stack stage's resources of one type (`ecs:service`, `ec2:instance`). */
const stackArns = Effect.fn(function* (stack: StackRef, type: string) {
  const pages = yield* tagging.getResources
    .pages({
      TagFilters: [
        { Key: "alchemy::stack", Values: [stack.name] },
        { Key: "alchemy::stage", Values: [stack.stage] },
      ],
      ResourceTypeFilters: [type],
    })
    .pipe(Stream.runCollect);
  return Array.from(pages).flatMap((page) =>
    (page.ResourceTagMappingList ?? []).flatMap((mapping) =>
      mapping.ResourceARN ? [mapping.ResourceARN] : [],
    ),
  );
});

/** The primary container of every ECS service in the stack, as its task definition declares it. */
export const serviceContainers = Effect.fn(function* (stack: StackRef) {
  const arns = yield* stackArns(stack, "ecs:service");
  return yield* Effect.forEach(
    arns,
    Effect.fn(function* (arn) {
      // arn:aws:ecs:region:account:service/cluster/name
      const cluster = arn.split("/")[1]!;
      const { services } = yield* ecs.describeServices({ cluster, services: [arn] });
      const { taskDefinition } = yield* ecs.describeTaskDefinition({
        taskDefinition: services?.[0]?.taskDefinition ?? "",
      });
      const container = taskDefinition?.containerDefinitions?.[0];
      return {
        service: arn,
        environment: Object.fromEntries(
          (container?.environment ?? []).map((entry) => [entry.name ?? "", entry.value ?? ""]),
        ),
        secrets: Object.fromEntries(
          (container?.secrets ?? []).map((entry) => [entry.name, entry.valueFrom]),
        ),
      };
    }),
    { concurrency: 4 },
  );
});

/** The decoded user data of every EC2 instance in the stack. */
export const instanceUserData = Effect.fn(function* (stack: StackRef) {
  const arns = yield* stackArns(stack, "ec2:instance");
  return yield* Effect.forEach(
    arns,
    Effect.fn(function* (arn) {
      const instanceId = arn.split("/").at(-1)!;
      const { UserData } = yield* ec2.describeInstanceAttribute({
        InstanceId: instanceId,
        Attribute: "userData",
      });
      return {
        instanceId,
        userData: Buffer.from(UserData?.Value ?? "", "base64").toString("utf8"),
      };
    }),
    { concurrency: 4 },
  );
});
