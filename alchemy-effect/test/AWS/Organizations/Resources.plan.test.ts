import {
  Account,
  AccountProvider,
  DelegatedAdministrator,
  DelegatedAdministratorProvider,
  Organization,
  OrganizationProvider,
  OrganizationalUnit,
  OrganizationalUnitProvider,
  Policy,
  PolicyAttachmentProvider,
  PolicyAttachment,
  PolicyProvider,
  Root,
  RootPolicyTypeProvider,
  RootPolicyType,
  RootProvider,
  TenantRoot,
  TrustedServiceAccess,
  TrustedServiceAccessProvider,
} from "@/AWS/Organizations";
import {
  AccountAssignment,
  AccountAssignmentProvider,
  Group,
  GroupProvider,
  Instance,
  InstanceProvider,
  PermissionSet,
  PermissionSetProvider,
} from "@/AWS/IdentityCenter";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import * as State from "@/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { Stage } from "../../../src/Stage.ts";

const providers = Layer.mergeAll(
  AccountProvider(),
  DelegatedAdministratorProvider(),
  OrganizationProvider(),
  OrganizationalUnitProvider(),
  PolicyAttachmentProvider(),
  PolicyProvider(),
  RootPolicyTypeProvider(),
  RootProvider(),
  TrustedServiceAccessProvider(),
  AccountAssignmentProvider(),
  GroupProvider(),
  InstanceProvider(),
  PermissionSetProvider(),
);

const stubProvider = {
  create: Effect.fn(function* () {
    return {} as any;
  }),
  update: Effect.fn(function* ({ output }: any) {
    return output;
  }),
  delete: Effect.fn(function* () {}),
};

const stubProviders = Layer.mergeAll(
  Organization.provider.succeed(stubProvider),
  Root.provider.succeed(stubProvider),
  RootPolicyType.provider.succeed(stubProvider),
  TrustedServiceAccess.provider.succeed(stubProvider),
  DelegatedAdministrator.provider.succeed(stubProvider),
  OrganizationalUnit.provider.succeed(stubProvider),
  Account.provider.succeed(stubProvider),
  Policy.provider.succeed(stubProvider),
  PolicyAttachment.provider.succeed(stubProvider),
  Instance.provider.succeed(stubProvider),
  Group.provider.succeed(stubProvider),
  PermissionSet.provider.succeed(stubProvider),
  AccountAssignment.provider.succeed(stubProvider),
);

const makePlan = <A>(
  effect: Effect.Effect<A, any, any>,
  resources: Record<string, State.ResourceState> = {},
) =>
  effect.pipe(
    Stack.make("organizations-plan-test", providers as any),
    Effect.provideService(Stage, "test"),
    Effect.flatMap(Plan.make),
    Effect.provide(providers as any),
    Effect.provideService(
      State.State,
      State.InMemoryService({
        "organizations-plan-test": {
          test: resources,
        },
      }),
    ),
  );

const makeStubPlan = <A>(effect: Effect.Effect<A, any, any>) =>
  effect.pipe(
    Stack.make("organizations-plan-test", stubProviders as any),
    Effect.provideService(Stage, "test"),
    Effect.flatMap(Plan.make),
    Effect.provide(stubProviders as any),
    Effect.provideService(
      State.State,
      State.InMemoryService({
        "organizations-plan-test": {
          test: {},
        },
      }),
    ),
  );

const instanceId = "test-instance-id";

describe("AWS.Organizations landing-zone planning", () => {
  it("plans account rename as update", async () => {
    const plan: any = await Effect.runPromise(
      makePlan(
        Effect.gen(function* () {
          yield* Account("TenantProdAccount", {
            name: "prod-renamed",
            email: "prod@example.com",
            parentId: "ou-workloads",
          });
        }),
        {
          TenantProdAccount: {
            instanceId,
            providerVersion: 0,
            logicalId: "TenantProdAccount",
            fqn: "TenantProdAccount",
            namespace: undefined,
            resourceType: "AWS.Organizations.Account",
            status: "created",
            props: {
              name: "prod",
              email: "prod@example.com",
              parentId: "ou-workloads",
            },
            attr: {
              accountId: "123456789012",
              accountArn: "arn:aws:organizations::123456789012:account/o-example/123456789012",
              name: "prod",
              email: "prod@example.com",
              parentId: "ou-workloads",
              status: "ACTIVE",
              state: "ACTIVE",
              joinedMethod: "CREATED",
              joinedTimestamp: new Date("2024-01-01T00:00:00.000Z"),
              tags: {},
            },
            bindings: [],
            downstream: [],
          } as State.ResourceState,
        },
      ) as any,
    );

    expect(plan.resources.TenantProdAccount).toMatchObject({
      action: "update",
      props: expect.objectContaining({
        name: "prod-renamed",
        email: "prod@example.com",
      }),
    });
  });

  it("TenantRoot composes baseline organization, accounts, and Identity Center resources", async () => {
    const plan: any = await Effect.runPromise(
      makeStubPlan(
        TenantRoot("CustomerA", {
          identityCenter: {
            mode: "existing",
            groups: [
              {
                key: "platform",
                displayName: "platform-engineers",
              },
            ],
            permissionSets: [
              {
                key: "admin",
                name: "AdministratorAccess",
                sessionDuration: "PT8H",
              },
            ],
            assignments: [
              {
                permissionSetKey: "admin",
                groupKey: "platform",
                accountKey: "prod",
              },
            ],
          },
          policies: [
            {
              key: "deny-root-user",
              name: "deny-root-user",
              document: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Deny",
                    Action: ["organizations:LeaveOrganization"],
                    Resource: "*",
                  },
                ],
              },
              targetKeys: ["root"],
            },
          ],
        }) as any,
      ) as any,
    );

    expect(plan.resources).toMatchObject({
      CustomerAOrganization: { action: "create" },
      CustomerARoot: { action: "create" },
      CustomerAServiceControlPolicyPolicyType: { action: "create" },
      CustomerASsoAmazonawsComTrustedAccess: { action: "create" },
      CustomerASecurityOu: { action: "create" },
      CustomerAInfrastructureOu: { action: "create" },
      CustomerAWorkloadsOu: { action: "create" },
      CustomerASecurityAccount: { action: "create" },
      CustomerALogArchiveAccount: { action: "create" },
      CustomerASharedServicesAccount: { action: "create" },
      CustomerAProdAccount: { action: "create" },
      CustomerAIdentityCenter: { action: "create" },
      CustomerAPlatformGroup: { action: "create" },
      CustomerAAdminPermissionSet: { action: "create" },
      CustomerAAdminProdPlatformAssignment: { action: "create" },
      CustomerADenyRootUserPolicy: { action: "create" },
      CustomerADenyRootUserRootAttachment: { action: "create" },
    });
  });
});
