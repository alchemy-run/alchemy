import * as AWS from "@alchemy.run/aws";
import { Resource as CloudControlResource } from "@alchemy.run/aws/CloudControl";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as CloudControl from "@distilled.cloud/aws/cloudcontrol";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { getAutoScalingTestSubnetId, getTestAmiId } from "../AutoScaling/TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class ResourceStillExists extends Data.TaggedError("ResourceStillExists") {}

const readValue = (
  properties: string | Redacted.Redacted<string> | undefined,
): string | undefined => {
  const raw =
    properties === undefined || typeof properties === "string"
      ? properties
      : Redacted.value(properties);
  if (raw === undefined) return undefined;
  return (JSON.parse(raw) as { Value?: string }).Value;
};

const assertDeleted = Effect.fn(function* (name: string, typeName = "AWS::SSM::Parameter") {
  yield* CloudControl.getResource({
    TypeName: typeName,
    Identifier: name,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists())),
    Effect.retry({
      while: (e) => e._tag === "ResourceStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

// Cloud Control takes the physical name verbatim, so scope it to the test
// stage (`test_$USER` by default) to keep concurrent developers apart.
const paramNameFor = (stage: string) => `/alchemy-test/${stage}/cloudcontrol/greeting`;

const resourceDef = (paramName: string, value: string) =>
  Effect.gen(function* () {
    const param = yield* CloudControlResource("CcParam", {
      typeName: "AWS::SSM::Parameter",
      desiredState: { Name: paramName, Type: "String", Value: value },
    });
    return { param };
  });

test.provider(
  "create, update (JSON patch), delete an SSM parameter via Cloud Control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const paramName = paramNameFor(stack.stage);

      // Create.
      const { param: created } = yield* stack.deploy(resourceDef(paramName, "hello"));
      expect(created.identifier).toBe(paramName);
      expect(created.typeName).toBe("AWS::SSM::Parameter");
      expect(created.properties.Value).toBe("hello");

      // Verify out-of-band.
      const described = yield* CloudControl.getResource({
        TypeName: "AWS::SSM::Parameter",
        Identifier: paramName,
      });
      expect(readValue(described.ResourceDescription?.Properties)).toBe("hello");

      // Update the value — a JSON Patch is computed over just the Value key.
      const { param: updated } = yield* stack.deploy(resourceDef(paramName, "world"));
      expect(updated.identifier).toBe(paramName);
      expect(updated.properties.Value).toBe("world");

      const reDescribed = yield* CloudControl.getResource({
        TypeName: "AWS::SSM::Parameter",
        Identifier: paramName,
      });
      expect(readValue(reDescribed.ResourceDescription?.Properties)).toBe("world");

      // Delete + wait gone.
      yield* stack.destroy();
      yield* assertDeleted(paramName);
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:cloudcontrol", "live"],
    timeout: 240_000,
  },
);

// An SSM Command document per test stage. SSM echoes JSON `Content` back as a
// formatted string and never returns the write-only `UpdateMethod`, so an
// update that keeps the content must not compute a content patch.
const documentNameFor = (stage: string) => `alchemy-test-${stage}-cloudcontrol-document`;

const documentContent = (message: string) => ({
  schemaVersion: "2.2",
  description: "Alchemy Cloud Control document test",
  mainSteps: [
    {
      action: "aws:runShellScript",
      name: "echo",
      inputs: { runCommand: [`echo ${message}`] },
    },
  ],
});

const documentDef = (documentName: string, message: string, owner = "alchemy") =>
  Effect.gen(function* () {
    const document = yield* CloudControlResource("CcDocument", {
      typeName: "AWS::SSM::Document",
      desiredState: {
        Name: documentName,
        DocumentType: "Command",
        DocumentFormat: "JSON",
        UpdateMethod: "NewVersion",
        Content: documentContent(message),
        Tags: [{ Key: "owner", Value: owner }],
      },
    });
    return { document };
  });

const readContent = (content: unknown) =>
  typeof content === "string" ? JSON.parse(content) : content;

test.provider(
  "updating a JSON SSM document without changing its content",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const documentName = documentNameFor(stack.stage);

      const { document: created } = yield* stack.deploy(documentDef(documentName, "hello"));
      expect(created.identifier).toBe(documentName);
      expect(readContent(created.properties.Content)).toEqual(documentContent("hello"));

      // Tags-only change: reconcile runs with unchanged content. A perpetual
      // `Content`/`UpdateMethod` patch would send an UpdateDocument with
      // identical content, which SSM rejects.
      const { document: unchanged } = yield* stack.deploy(
        documentDef(documentName, "hello", "platform"),
      );
      expect(unchanged.identifier).toBe(documentName);
      expect(readContent(unchanged.properties.Content)).toEqual(documentContent("hello"));

      // A real content change still patches, as a new document version.
      const { document: updated } = yield* stack.deploy(
        documentDef(documentName, "world", "platform"),
      );
      expect(updated.identifier).toBe(documentName);
      expect(readContent(updated.properties.Content)).toEqual(documentContent("world"));

      yield* stack.destroy();
      yield* assertDeleted(documentName, "AWS::SSM::Document");
    }).pipe(logLevel),
  {
    tags: ["provider:aws", "provider:aws:cloudcontrol", "live"],
    timeout: 240_000,
  },
);

// Cloud Control reads an Auto Scaling group back with a `SuspendedProcesses: []`
// that is not in the schema, and rejects every update that leaves it in place
// ("Setting SuspendedProcesses is currently not available"). The provider must
// remove it in the same patch. The launch template is created out-of-band (see
// AutoScaling/AutoScalingGroup.test.ts) and the group is sized to zero.
const asgName = "alchemy-test-cloudcontrol-asg";
const asgLaunchTemplateName = "alchemy-test-cloudcontrol-asg-lt";

const cleanupAsg = Effect.gen(function* () {
  yield* autoscaling
    .deleteAutoScalingGroup({ AutoScalingGroupName: asgName, ForceDelete: true } as any)
    .pipe(Effect.catch(() => Effect.void));
  yield* ec2
    .deleteLaunchTemplate({ LaunchTemplateName: asgLaunchTemplateName } as any)
    .pipe(Effect.catch(() => Effect.void));
});

const asgDef = (subnetId: string, maxSize: string) =>
  Effect.gen(function* () {
    const group = yield* CloudControlResource("CcAsg", {
      typeName: "AWS::AutoScaling::AutoScalingGroup",
      desiredState: {
        AutoScalingGroupName: asgName,
        MinSize: "0",
        MaxSize: maxSize,
        VPCZoneIdentifier: [subnetId],
        LaunchTemplate: {
          LaunchTemplateName: asgLaunchTemplateName,
          Version: "1",
        },
      },
    });
    return { group };
  });

const describeAsgMaxSize = autoscaling
  .describeAutoScalingGroups({ AutoScalingGroupNames: [asgName] } as any)
  .pipe(Effect.map((r) => r.AutoScalingGroups?.[0]?.MaxSize));

test.provider(
  "updating an Auto Scaling group removes the non-schema SuspendedProcesses",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* cleanupAsg;

      const imageId = yield* getTestAmiId;
      const subnetId = yield* getAutoScalingTestSubnetId;
      yield* ec2.createLaunchTemplate({
        LaunchTemplateName: asgLaunchTemplateName,
        LaunchTemplateData: { ImageId: imageId, InstanceType: "t3.micro" },
      } as any);

      const { group: created } = yield* stack.deploy(asgDef(subnetId, "0"));
      expect(created.identifier).toBe(asgName);
      expect(yield* describeAsgMaxSize).toBe(0);

      // A real change patches over the observed `SuspendedProcesses: []`.
      const { group: updated } = yield* stack.deploy(asgDef(subnetId, "1"));
      expect(updated.identifier).toBe(asgName);
      expect(yield* describeAsgMaxSize).toBe(1);

      yield* stack.destroy();
      yield* assertDeleted(asgName, "AWS::AutoScaling::AutoScalingGroup");
    }).pipe(logLevel, Effect.ensuring(cleanupAsg)),
  {
    tags: ["provider:aws", "provider:aws:cloudcontrol", "provider:aws:autoscaling", "live"],
    timeout: 360_000,
  },
);
