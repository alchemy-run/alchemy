import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const aws = AWS.providers() as any;

const TENANT_EMAIL_DOMAIN = Config.string("TENANT_EMAIL_DOMAIN").pipe(
  (config) => config.asEffect(),
);

const stack = Effect.gen(function* () {
  /**
   * Set `TENANT_EMAIL_DOMAIN` before deploy so the example account emails are
   * globally unique in AWS Organizations, for example:
   *
   * TENANT_EMAIL_DOMAIN=customer-a.example.com
   */
  const emailDomain = yield* TENANT_EMAIL_DOMAIN;

  const tenant = yield* AWS.Organizations.TenantRoot("CustomerA", {
    organizationalUnits: [
      {
        key: "security",
        accounts: [
          {
            key: "security",
            name: "security",
            email: `security@${emailDomain}`,
          },
          {
            key: "log-archive",
            name: "log-archive",
            email: `log-archive@${emailDomain}`,
          },
        ],
      },
      {
        key: "infrastructure",
        accounts: [
          {
            key: "shared-services",
            name: "shared-services",
            email: `shared-services@${emailDomain}`,
          },
        ],
      },
      {
        key: "workloads",
        accounts: [
          {
            key: "prod",
            name: "prod",
            email: `prod@${emailDomain}`,
          },
        ],
      },
    ],
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
        key: "deny-leave-org",
        name: "deny-leave-org",
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
    tags: {
      Example: "aws-organizations-landing-zone",
      Surface: "organizations",
    },
  });

  return {
    organizationId: tenant.organization.organizationId,
    rootId: tenant.root.rootId,
    accounts: Object.fromEntries(
      Object.entries(tenant.accounts).map(([key, account]) => [key, account.accountId]),
    ),
    organizationalUnits: Object.fromEntries(
      Object.entries(tenant.organizationalUnits).map(([key, ou]) => [key, ou.ouId]),
    ),
    permissionSets: tenant.identityCenter
      ? Object.fromEntries(
          Object.entries(tenant.identityCenter.permissionSets).map(
            ([key, permissionSet]) => [key, permissionSet.permissionSetArn],
          ),
        )
      : {},
  };
}).pipe(Stack.make("AwsOrganizationsLandingZoneExample", aws) as any);

export default stack;
