<!-- Docs for the generated AWS.Grafana bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateLicense

Runtime binding for the `AssociateLicense` operation (IAM action
`grafana:AssociateLicense`), scoped to one {@link Workspace}.

Assigns a Grafana Enterprise license to the workspace. Pass a valid
Grafana Labs token as `grafanaToken` when upgrading to `ENTERPRISE`.
Upgrading incurs additional fees. Provide the implementation with
`Effect.provide(AWS.Grafana.AssociateLicenseHttp)`.
### Managing Licenses
**Example:** Upgrade to Grafana Enterprise
```typescript
const associateLicense = yield* Grafana.AssociateLicense(workspace);

const { workspace: ws } = yield* associateLicense({
  licenseType: "ENTERPRISE",
  grafanaToken: token,
});
// ws.licenseType → "ENTERPRISE"
```

@binding

## CreateWorkspaceServiceAccount

Runtime binding for the `CreateWorkspaceServiceAccount` operation (IAM
action `grafana:CreateWorkspaceServiceAccount`), scoped to one
{@link Workspace}.

Creates a Grafana service account in the workspace — a non-user identity
for machine access to the Grafana HTTP API (dashboards, alerts, data
sources). Mint API tokens for it with
`CreateWorkspaceServiceAccountToken`. Requires Grafana 9 or newer.
Provide the implementation with
`Effect.provide(AWS.Grafana.CreateWorkspaceServiceAccountHttp)`.
### Managing Service Accounts
**Example:** Create an Automation Service Account
```typescript
const createServiceAccount =
  yield* Grafana.CreateWorkspaceServiceAccount(workspace);

const account = yield* createServiceAccount({
  name: "dashboard-automation",
  grafanaRole: "EDITOR",
});
// account.id → the service account id used for token operations
```

@binding

## DeleteWorkspaceServiceAccount

Runtime binding for the `DeleteWorkspaceServiceAccount` operation (IAM
action `grafana:DeleteWorkspaceServiceAccount`), scoped to one
{@link Workspace}.

Deletes a Grafana service account from the workspace. Any API tokens
minted for the account stop working immediately. Provide the
implementation with
`Effect.provide(AWS.Grafana.DeleteWorkspaceServiceAccountHttp)`.
### Managing Service Accounts
**Example:** Delete a Service Account
```typescript
const deleteServiceAccount =
  yield* Grafana.DeleteWorkspaceServiceAccount(workspace);

yield* deleteServiceAccount({ serviceAccountId: account.id });
```

@binding

## DeleteWorkspaceServiceAccountToken

Runtime binding for the `DeleteWorkspaceServiceAccountToken` operation
(IAM action `grafana:DeleteWorkspaceServiceAccountToken`), scoped to one
{@link Workspace}.

Revokes a service account API token — the other half of a token-rotation
loop. Provide the implementation with
`Effect.provide(AWS.Grafana.DeleteWorkspaceServiceAccountTokenHttp)`.
### Managing Service Accounts
**Example:** Revoke a Rotated-Out Token
```typescript
const deleteToken =
  yield* Grafana.DeleteWorkspaceServiceAccountToken(workspace);

yield* deleteToken({
  serviceAccountId: account.id,
  tokenId: staleToken.id,
});
```

@binding

## DescribeWorkspaceAuthentication

Runtime binding for the `DescribeWorkspaceAuthentication` operation (IAM
action `grafana:DescribeWorkspaceAuthentication`), scoped to one
{@link Workspace}.

Reads the workspace's authentication configuration — the enabled providers
(`AWS_SSO`, `SAML`) and, for SAML, the IdP metadata, assertion-attribute
mapping, and role values. Provide the implementation with
`Effect.provide(AWS.Grafana.DescribeWorkspaceAuthenticationHttp)`.
### Managing Authentication
**Example:** Inspect the SAML Configuration Status
```typescript
const describeAuth = yield* Grafana.DescribeWorkspaceAuthentication(workspace);

const { authentication } = yield* describeAuth();
// authentication.providers → ["SAML"]
// authentication.saml?.status → "CONFIGURED" | "NOT_CONFIGURED"
```

@binding

## DescribeWorkspaceConfiguration

Runtime binding for the `DescribeWorkspaceConfiguration` operation (IAM
action `grafana:DescribeWorkspaceConfiguration`), scoped to one
{@link Workspace}.

Reads the workspace's Grafana configuration JSON string (e.g. the
`unifiedAlerting` feature toggle) and the running Grafana version. Provide
the implementation with
`Effect.provide(AWS.Grafana.DescribeWorkspaceConfigurationHttp)`.
### Managing Configuration
**Example:** Read the Configuration JSON
```typescript
const describeConfig = yield* Grafana.DescribeWorkspaceConfiguration(workspace);

const { configuration, grafanaVersion } = yield* describeConfig();
const parsed = JSON.parse(configuration);
```

@binding

## DisassociateLicense

Runtime binding for the `DisassociateLicense` operation (IAM action
`grafana:DisassociateLicense`), scoped to one {@link Workspace}.

Removes the Grafana Enterprise license from the workspace, downgrading it
back to the standard edition. Provide the implementation with
`Effect.provide(AWS.Grafana.DisassociateLicenseHttp)`.
### Managing Licenses
**Example:** Downgrade from Grafana Enterprise
```typescript
const disassociateLicense = yield* Grafana.DisassociateLicense(workspace);

yield* disassociateLicense({ licenseType: "ENTERPRISE" });
```

@binding

## ListPermissions

Runtime binding for the `ListPermissions` operation (IAM action
`grafana:ListPermissions`), scoped to one {@link Workspace}.

Lists the IAM Identity Center users and groups granted the `ADMIN`,
`EDITOR`, or `VIEWER` role in the workspace, optionally filtered by user
or group id. Provide the implementation with
`Effect.provide(AWS.Grafana.ListPermissionsHttp)`.
### Managing Permissions
**Example:** List Workspace Role Assignments
```typescript
const listPermissions = yield* Grafana.ListPermissions(workspace);

const { permissions } = yield* listPermissions();
for (const entry of permissions) {
  yield* Effect.logInfo(`${entry.user.id} → ${entry.role}`);
}
```

@binding

## ListVersions

Runtime binding for the `ListVersions` operation (IAM action
`grafana:ListVersions`).

Lists the Grafana versions available when creating a workspace, or — with
a `workspaceId` — the versions an existing workspace can be upgraded to.
Provide the implementation with
`Effect.provide(AWS.Grafana.ListVersionsHttp)`.
### Managing Configuration
**Example:** List the Available Grafana Versions
```typescript
const listVersions = yield* Grafana.ListVersions();

const { grafanaVersions } = yield* listVersions();
// grafanaVersions → ["10.4", "9.4", ...]
```

@binding

## ListWorkspaceServiceAccountTokens

Runtime binding for the `ListWorkspaceServiceAccountTokens` operation
(IAM action `grafana:ListWorkspaceServiceAccountTokens`), scoped to one
{@link Workspace}.

Lists the API tokens of a Grafana service account (metadata only — the
secret key is only returned at mint time). Provide the implementation with
`Effect.provide(AWS.Grafana.ListWorkspaceServiceAccountTokensHttp)`.
### Managing Service Accounts
**Example:** Find Expired Tokens to Revoke
```typescript
const listTokens =
  yield* Grafana.ListWorkspaceServiceAccountTokens(workspace);

const { serviceAccountTokens } = yield* listTokens({
  serviceAccountId: account.id,
});
const expired = serviceAccountTokens.filter(
  (token) => token.expiresAt.getTime() < Date.now(),
);
```

@binding

## ListWorkspaceServiceAccounts

Runtime binding for the `ListWorkspaceServiceAccounts` operation (IAM
action `grafana:ListWorkspaceServiceAccounts`), scoped to one
{@link Workspace}.

Lists the Grafana service accounts in the workspace. Provide the
implementation with
`Effect.provide(AWS.Grafana.ListWorkspaceServiceAccountsHttp)`.
### Managing Service Accounts
**Example:** List the Workspace's Service Accounts
```typescript
const listServiceAccounts =
  yield* Grafana.ListWorkspaceServiceAccounts(workspace);

const { serviceAccounts } = yield* listServiceAccounts();
for (const account of serviceAccounts) {
  yield* Effect.logInfo(`${account.name} (${account.grafanaRole})`);
}
```

@binding

## UpdatePermissions

Runtime binding for the `UpdatePermissions` operation (IAM action
`grafana:UpdatePermissions`), scoped to one {@link Workspace}.

Grants or revokes the `ADMIN`, `EDITOR`, or `VIEWER` role for IAM Identity
Center users and groups in the workspace. Rejected instructions come back
in the response's `errors` list rather than failing the call. Provide the
implementation with `Effect.provide(AWS.Grafana.UpdatePermissionsHttp)`.
### Managing Permissions
**Example:** Grant a User the Editor Role
```typescript
const updatePermissions = yield* Grafana.UpdatePermissions(workspace);

const { errors } = yield* updatePermissions({
  updateInstructionBatch: [
    {
      action: "ADD",
      role: "EDITOR",
      users: [{ id: userId, type: "SSO_USER" }],
    },
  ],
});
// errors → [] when every instruction applied
```

@binding

## UpdateWorkspaceAuthentication

Runtime binding for the `UpdateWorkspaceAuthentication` operation (IAM
action `grafana:UpdateWorkspaceAuthentication`), scoped to one
{@link Workspace}.

Defines the SAML identity provider the workspace authenticates users from
— IdP metadata, assertion-attribute mapping, and which groups receive the
`Admin` and `Editor` roles. Changes can take a few minutes to apply.
Provide the implementation with
`Effect.provide(AWS.Grafana.UpdateWorkspaceAuthenticationHttp)`.
### Managing Authentication
**Example:** Configure a SAML Identity Provider
```typescript
const updateAuth = yield* Grafana.UpdateWorkspaceAuthentication(workspace);

yield* updateAuth({
  authenticationProviders: ["SAML"],
  samlConfiguration: {
    idpMetadata: { url: "https://idp.example.com/metadata.xml" },
    assertionAttributes: { role: "grafanaRole" },
    roleValues: { admin: ["platform-team"] },
  },
});
```

@binding

## UpdateWorkspaceConfiguration

Runtime binding for the `UpdateWorkspaceConfiguration` operation (IAM
action `grafana:UpdateWorkspaceConfiguration`), scoped to one
{@link Workspace}.

Writes the workspace's Grafana configuration JSON string and can also
trigger an in-place Grafana version upgrade via `grafanaVersion`. Provide
the implementation with
`Effect.provide(AWS.Grafana.UpdateWorkspaceConfigurationHttp)`.
### Managing Configuration
**Example:** Enable Unified Alerting
```typescript
const updateConfig = yield* Grafana.UpdateWorkspaceConfiguration(workspace);

yield* updateConfig({
  configuration: JSON.stringify({
    unifiedAlerting: { enabled: true },
  }),
});
```

@binding
