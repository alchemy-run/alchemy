import * as AWS from "@/AWS";
import { NetworkAcl, NetworkAclAssociation, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed NetworkAclAssociation", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { assoc } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListNaclAssocVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("ListNaclAssocSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        const acl = yield* NetworkAcl("ListNaclAssocAcl", {
          vpcId: vpc.vpcId,
        });
        const assoc = yield* NetworkAclAssociation("ListNaclAssoc", {
          networkAclId: acl.networkAclId,
          subnetId: subnet.subnetId,
        });
        return { vpc, subnet, acl, assoc };
      }),
    );

    const provider = yield* Provider.findProvider(NetworkAclAssociation);
    const all = yield* provider.list();

    expect(all.some((x) => x.associationId === assoc.associationId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
