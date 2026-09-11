import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  describeInstance,
  errorResponse,
  instance,
  instanceId,
  props,
  reconcile,
  response,
  withInstance,
} from "./DBInstance.provider.ts";

it.effect(
  "refreshes legacy outputs before exposing observed associations",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(instance())
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          const output = yield* reconcile(provider, props);
          // Reproduce an existing state row written before these attributes existed.
          Reflect.deleteProperty(output, "dbParameterGroups");
          Reflect.deleteProperty(output, "vpcSecurityGroups");
          const beforePlanning = requests.length;
          expect(
            yield* provider.diff!({
              id: "Db",
              fqn: "Db",
              instanceId,
              olds: props,
              news: props,
              output,
              oldBindings: [],
              newBindings: [],
            }),
          ).toEqual({ action: "update" });
          expect(requests).toHaveLength(beforePlanning);
        }),
    ),
);

const auroraInstance = instance({
  DBClusterIdentifier: "cluster",
  DBInstanceClass: "db.t3.medium",
  Engine: "aurora-postgresql",
  Endpoint: { Port: 5432 },
  DeletionProtection: false,
  IAMDatabaseAuthenticationEnabled: false,
  NetworkType: "IPV4",
  PubliclyAccessible: false,
  EnabledCloudwatchLogsExports: [],
  VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-cluster", Status: "active" }],
});

const auroraProps = {
  ...props,
  engine: "aurora-postgresql",
  dbInstanceClass: "db.t3.medium",
  dbClusterIdentifier: "cluster",
  port: 15432,
  deletionProtection: true,
  enableIAMDatabaseAuthentication: true,
  networkType: "DUAL",
  enableCloudwatchLogsExports: ["postgresql"],
  vpcSecurityGroupIds: ["sg-instance"],
};

const expectNoClusterSettings = (parameters: URLSearchParams) => {
  for (const field of [
    "Port",
    "DBPortNumber",
    "DeletionProtection",
    "EnableIAMDatabaseAuthentication",
    "VpcSecurityGroupIds",
    "NetworkType",
    "EnableCloudwatchLogsExports",
    "CloudwatchLogsExportConfiguration",
  ]) {
    expect(
      [...parameters.keys()].some(
        (key) => key === field || key.startsWith(`${field}.`),
      ),
    ).toBe(false);
  }
};

it.effect(
  "Aurora ignores cluster-owned security settings during reconcile and planning",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(auroraInstance)
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          const output = yield* reconcile(provider, auroraProps);
          expect(output.endpointPort).toBe(5432);
          expect(output.deletionProtection).toBe(false);
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toEqual([]);
          const beforePlanning = requests.length;
          const diff = yield* provider.diff!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: auroraProps,
            news: auroraProps,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff).toBeUndefined();
          expect(requests).toHaveLength(beforePlanning);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "Aurora creation sends only instance-owned security settings",
  () => {
    let created = false;
    const observed = instance({
      ...auroraInstance,
      PubliclyAccessible: true,
      DBParameterGroups: [
        { DBParameterGroupName: "custom", ParameterApplyStatus: "in-sync" },
      ],
    });
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances")
          return describeInstance(created ? observed : undefined);
        if (action === "CreateDBInstance") created = true;
        return response(action, "");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const output = yield* reconcile(provider, {
            ...auroraProps,
            publiclyAccessible: true,
            dbParameterGroupName: "custom",
          });
          const creates = requests.filter(
            ({ action }) => action === "CreateDBInstance",
          );
          expect(creates).toHaveLength(1);
          expectNoClusterSettings(creates[0]!.parameters);
          expect(creates[0]!.parameters.get("PubliclyAccessible")).toBe("true");
          expect(creates[0]!.parameters.get("DBParameterGroupName")).toBe(
            "custom",
          );
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toEqual([]);
          expect(output.publiclyAccessible).toBe(true);
          expect(output.dbParameterGroupNames).toEqual(["custom"]);
          expect(output.endpointPort).toBe(5432);
          expect(output.deletionProtection).toBe(false);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "Aurora still reconciles public accessibility and its instance parameter group",
  () => {
    let modified = false;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances")
          return describeInstance(
            instance({
              ...auroraInstance,
              PubliclyAccessible: modified,
              DBParameterGroups: [
                {
                  DBParameterGroupName: modified
                    ? "custom"
                    : "default.aurora-postgresql16",
                  ParameterApplyStatus: "in-sync",
                },
              ],
            }),
          );
        if (action === "ModifyDBInstance") modified = true;
        return response(action, "");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const output = yield* reconcile(provider, {
            ...auroraProps,
            publiclyAccessible: true,
            dbParameterGroupName: "custom",
          });
          const modifies = requests.filter(
            ({ action }) => action === "ModifyDBInstance",
          );
          expect(modifies).toHaveLength(1);
          expectNoClusterSettings(modifies[0]!.parameters);
          expect(modifies[0]!.parameters.get("PubliclyAccessible")).toBe(
            "true",
          );
          expect(modifies[0]!.parameters.get("DBParameterGroupName")).toBe(
            "custom",
          );
          expect(output.publiclyAccessible).toBe(true);
          expect(output.dbParameterGroupNames).toEqual(["custom"]);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "reports pending-reboot without rebooting or claiming parameters are applied",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(
              instance({
                DBParameterGroups: [
                  {
                    DBParameterGroupName: "custom",
                    ParameterApplyStatus: "pending-reboot",
                  },
                ],
              }),
            )
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, {
            ...props,
            dbParameterGroupName: "custom",
          });
          expect(result.dbParameterGroupNames).toEqual(["custom"]);
          expect(result.dbParameterGroups).toEqual([
            { name: "custom", status: "pending-reboot" },
          ]);
          expect(
            requests.some(({ action }) => action === "RebootDBInstance"),
          ).toBe(false);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "plans correction of live security drift while keeping stable identifiers",
  () => {
    let publicAccess = false;
    return withInstance(
      () => describeInstance(instance({ PubliclyAccessible: publicAccess })),
      (provider) =>
        Effect.gen(function* () {
          const news = { ...props, publiclyAccessible: false };
          const output = yield* provider.read!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            output: undefined,
          });
          publicAccess = true;
          const diff = yield* provider.diff!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            news,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff).toEqual({ action: "update" });
          expect(provider.stables).toEqual([
            "dbInstanceArn",
            "dbInstanceIdentifier",
          ]);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "a missing instance invalidates stable references",
  () => {
    let missing = false;
    return withInstance(
      () =>
        describeInstance(
          missing ? undefined : instance({ PubliclyAccessible: false }),
        ),
      (provider) =>
        Effect.gen(function* () {
          const news = { ...props, publiclyAccessible: false };
          const output = yield* provider.read!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            output: undefined,
          });
          missing = true;
          const diff = yield* provider.diff!({
            id: "Db",
            fqn: "Db",
            instanceId,
            olds: news,
            news,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff).toEqual({ action: "update", stables: [] });
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "waits for security-group application after the instance becomes available",
  () => {
    let modified = false;
    let postModifyReads = 0;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances")
          return describeInstance(
            instance({
              VpcSecurityGroups: [
                {
                  VpcSecurityGroupId: modified ? "sg-new" : "sg-old",
                  Status:
                    modified && ++postModifyReads > 2 ? "active" : "modifying",
                },
              ],
            }),
          );
        if (action === "ModifyDBInstance") modified = true;
        return response(action, "");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, {
            ...props,
            vpcSecurityGroupIds: ["sg-new"],
          });
          expect(result.vpcSecurityGroups).toEqual([
            { id: "sg-new", status: "active" },
          ]);
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toHaveLength(1);
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "replaces a conflicting pending IAM-authentication change and verifies it cleared",
  () => {
    let modified = false;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances")
          return describeInstance(
            instance({
              IAMDatabaseAuthenticationEnabled: true,
              PendingModifiedValues: modified
                ? {}
                : { IAMDatabaseAuthenticationEnabled: false },
            }),
          );
        if (action === "ModifyDBInstance") modified = true;
        return response(action, "");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, {
            ...props,
            enableIAMDatabaseAuthentication: true,
          });
          expect(result.iamDatabaseAuthenticationEnabled).toBe(true);
          expect(
            result.pendingIamDatabaseAuthenticationEnabled,
          ).toBeUndefined();
          const modifies = requests.filter(
            ({ action }) => action === "ModifyDBInstance",
          );
          expect(modifies).toHaveLength(1);
          expect(
            modifies[0]!.parameters.get("EnableIAMDatabaseAuthentication"),
          ).toBe("true");
          expect(modifies[0]!.parameters.get("ApplyImmediately")).toBe("true");
        }),
    );
  },
  { timeout: 5000 },
);

it.effect(
  "configuration polling is bounded and does not resend modifications",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(instance({ PubliclyAccessible: true }))
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, {
            ...props,
            publiclyAccessible: false,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("DBInstanceConfigurationPending");
          expect(
            requests.filter(({ action }) => action === "DescribeDBInstances"),
          ).toHaveLength(14);
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toHaveLength(1);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "configuration polling propagates authorization failures immediately",
  () => {
    let reads = 0;
    return withInstance(
      () =>
        ++reads > 2
          ? errorResponse("AccessDenied", 403)
          : describeInstance(instance({ PubliclyAccessible: false })),
      (provider, requests) =>
        Effect.gen(function* () {
          const error = yield* reconcile(provider, {
            ...props,
            publiclyAccessible: false,
          }).pipe(Effect.flip);
          expect(error._tag).not.toBe("DBInstanceConfigurationPending");
          expect(requests).toHaveLength(3);
        }),
    );
  },
  { timeout: 5000 },
);
