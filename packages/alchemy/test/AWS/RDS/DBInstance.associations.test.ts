import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  describeInstance,
  instance,
  props,
  reconcile,
  response,
  withInstance,
} from "./DBInstance.provider.ts";

it.effect(
  "unchanged parameter and security groups do not issue a modify",
  () =>
    withInstance(
      ({ action }) =>
        action === "DescribeDBInstances"
          ? describeInstance(
              instance({
                DBParameterGroups: [
                  {
                    DBParameterGroupName: "custom",
                    ParameterApplyStatus: "in-sync",
                  },
                ],
                VpcSecurityGroups: [
                  { VpcSecurityGroupId: "sg-b", Status: "active" },
                  { VpcSecurityGroupId: "sg-a", Status: "active" },
                ],
              }),
            )
          : response(action, ""),
      (provider, requests) =>
        Effect.gen(function* () {
          yield* reconcile(provider, {
            ...props,
            dbParameterGroupName: "custom",
            vpcSecurityGroupIds: ["sg-a", "sg-b", "sg-a"],
          });
          expect(
            requests.filter(({ action }) => action === "ModifyDBInstance"),
          ).toEqual([]);
        }),
    ),
  { timeout: 5000 },
);

it.effect(
  "changed associations are sent once and observed",
  () => {
    let changed = false;
    return withInstance(
      ({ action }) => {
        if (action === "DescribeDBInstances")
          return describeInstance(
            instance({
              DBParameterGroups: [
                {
                  DBParameterGroupName: changed ? "custom" : "default.postgres",
                  ParameterApplyStatus: "in-sync",
                },
              ],
              VpcSecurityGroups: [
                {
                  VpcSecurityGroupId: changed ? "sg-new" : "sg-old",
                  Status: "active",
                },
              ],
            }),
          );
        if (action === "ModifyDBInstance") changed = true;
        return response(action, "");
      },
      (provider, requests) =>
        Effect.gen(function* () {
          yield* reconcile(provider, {
            ...props,
            dbParameterGroupName: "custom",
            vpcSecurityGroupIds: ["sg-new"],
          });
          const modifies = requests.filter(
            ({ action }) => action === "ModifyDBInstance",
          );
          expect(modifies).toHaveLength(1);
          expect(modifies[0]!.parameters.get("DBParameterGroupName")).toBe(
            "custom",
          );
          expect(
            modifies[0]!.parameters.get(
              "VpcSecurityGroupIds.VpcSecurityGroupId.1",
            ),
          ).toBe("sg-new");
        }),
    );
  },
  { timeout: 5000 },
);
