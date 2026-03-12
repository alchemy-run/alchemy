import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import { Stage } from "alchemy-effect/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiTask } from "./src/ApiTask.ts";
import { QueuePollerTask } from "./src/QueuePollerTask.ts";

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      return {
        account: "123456789012",
        region: "us-west-2",
      };
    }

    return yield* AWS.loadDefaultStageConfig();
  }).pipe(Effect.orDie),
);

const aws = AWS.providers().pipe(Layer.provide(awsConfig));

const stack = Effect.gen(function* () {
  const dashboardRegion = yield* AWS.Region;
  const network = yield* AWS.EC2.Network("ExampleNetwork", {
    cidrBlock: "10.42.0.0/16",
    availabilityZones: 2,
  });

  const serviceSecurityGroup = yield* AWS.EC2.SecurityGroup(
    "ExampleServiceSecurityGroup",
    {
      vpcId: network.vpcId,
      description: "Security group for the ECS example services",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
        },
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    },
  );

  const queue = yield* AWS.SQS.Queue("ExampleJobsQueue", {
    receiveMessageWaitTimeSeconds: 20,
    visibilityTimeout: 60,
  });

  const cluster = yield* AWS.ECS.Cluster("ExampleCluster", {});
  const apiTask = yield* ApiTask(queue);
  const queuePollerTask = yield* QueuePollerTask(queue);

  const apiService = yield* AWS.ECS.Service("ExampleApiService", {
    cluster,
    task: apiTask,
    vpcId: network.vpcId,
    subnets: network.publicSubnetIds,
    securityGroups: [serviceSecurityGroup.groupId],
    assignPublicIp: true,
    public: true,
    healthCheckPath: "/",
  });

  yield* AWS.ECS.Service("ExampleQueuePollerService", {
    cluster,
    task: queuePollerTask,
    vpcId: network.vpcId,
    subnets: network.publicSubnetIds,
    securityGroups: [serviceSecurityGroup.groupId],
    assignPublicIp: true,
    desiredCount: 1,
  });

  const dashboard = yield* AWS.CloudWatch.Dashboard("ExampleEcsDashboard", {
    DashboardBody: Output.all(
      cluster.clusterName,
      apiService.serviceName,
      queue.queueName,
    ).pipe(
      Output.map(([clusterName, serviceName, queueName]) => ({
        widgets: [
          {
            type: "metric",
            x: 0,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "API Service CPU and Memory",
              region: dashboardRegion,
              period: 300,
              stat: "Average",
              metrics: [
                [
                  "AWS/ECS",
                  "CPUUtilization",
                  "ClusterName",
                  clusterName,
                  "ServiceName",
                  serviceName,
                ],
                [".", "MemoryUtilization", ".", ".", ".", "."],
              ],
            },
          },
          {
            type: "metric",
            x: 12,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "SQS Queue Backlog",
              region: dashboardRegion,
              period: 300,
              stat: "Average",
              metrics: [
                [
                  "AWS/SQS",
                  "ApproximateNumberOfMessagesVisible",
                  "QueueName",
                  queueName,
                ],
                [".", "ApproximateAgeOfOldestMessage", ".", "."],
              ],
            },
          },
        ],
      })),
    ),
  });

  const alarm = yield* AWS.CloudWatch.Alarm("ExampleQueueBacklogAlarm", {
    AlarmDescription:
      "Alerts when the ECS example queue backlog grows beyond the expected steady state.",
    MetricName: "ApproximateNumberOfMessagesVisible",
    Namespace: "AWS/SQS",
    Statistic: "Average",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 10,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    Dimensions: [
      {
        Name: "QueueName",
        Value: queue.queueName,
      },
    ],
  });

  return {
    url: apiService.url,
    queueUrl: queue.queueUrl,
    enqueueExample: Output.interpolate`${apiService.url}/enqueue?message=hello`,
    dashboardName: dashboard.dashboardName,
    alarmName: alarm.alarmName,
  };
}).pipe(Stack.make("AwsEcsExample", aws));

export default stack;
