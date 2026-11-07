<!-- Docs for the generated AWS.Chatbot bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteMicrosoftTeamsConfiguredTeam

Runtime binding for `chatbot:DeleteMicrosoftTeamsConfiguredTeam`.

Removes an onboarded Microsoft Teams team from AWS Chatbot — the drastic
end of offboarding automation. Existing channel configurations for the
team stop working until it is re-onboarded via the console OAuth flow.
Provide the implementation with
`Effect.provide(AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeamHttp)`.
### Microsoft Teams Identity Management
**Example:** Offboard a Microsoft Teams team
```typescript
const deleteMicrosoftTeamsConfiguredTeam =
  yield* AWS.Chatbot.DeleteMicrosoftTeamsConfiguredTeam();
yield* deleteMicrosoftTeamsConfiguredTeam({
  TeamId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
});
```

@binding

## DeleteMicrosoftTeamsUserIdentity

Runtime binding for `chatbot:DeleteMicrosoftTeamsUserIdentity`.

Unlinks a Microsoft Teams user identity from its AWS user identity — the
write half of identity offboarding automation. Provide the implementation
with `Effect.provide(AWS.Chatbot.DeleteMicrosoftTeamsUserIdentityHttp)`.
### Microsoft Teams Identity Management
**Example:** Unlink a Teams user identity
```typescript
const deleteMicrosoftTeamsUserIdentity =
  yield* AWS.Chatbot.DeleteMicrosoftTeamsUserIdentity();
yield* deleteMicrosoftTeamsUserIdentity({
  ChatConfigurationArn: configurationArn,
  UserId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
});
```

@binding

## DeleteSlackUserIdentity

Runtime binding for `chatbot:DeleteSlackUserIdentity`.

Unlinks a Slack user identity from its AWS user identity — the write half
of identity offboarding automation (e.g. revoke a departing employee's
chat identity from a Lambda triggered by your HR system). Provide the
implementation with
`Effect.provide(AWS.Chatbot.DeleteSlackUserIdentityHttp)`.
### Slack Identity Management
**Example:** Unlink a Slack user identity
```typescript
const deleteSlackUserIdentity =
  yield* AWS.Chatbot.DeleteSlackUserIdentity();
yield* deleteSlackUserIdentity({
  ChatConfigurationArn: configurationArn,
  SlackTeamId: "T012ABCDEFG",
  SlackUserId: "U012AB3CD",
});
```

@binding

## DeleteSlackWorkspaceAuthorization

Runtime binding for `chatbot:DeleteSlackWorkspaceAuthorization`.

Revokes AWS Chatbot's authorization for an entire Slack workspace — the
drastic end of offboarding automation. Existing channel configurations
for the workspace stop working until it is re-authorized via the console
OAuth flow. Provide the implementation with
`Effect.provide(AWS.Chatbot.DeleteSlackWorkspaceAuthorizationHttp)`.
### Slack Identity Management
**Example:** Revoke a Slack workspace authorization
```typescript
const deleteSlackWorkspaceAuthorization =
  yield* AWS.Chatbot.DeleteSlackWorkspaceAuthorization();
yield* deleteSlackWorkspaceAuthorization({ SlackTeamId: "T012ABCDEFG" });
```

@binding

## DescribeSlackUserIdentities

Runtime binding for `chatbot:DescribeSlackUserIdentities`.

Lists the Slack user identities linked to AWS user identities, optionally
filtered to one channel configuration — the read half of identity
offboarding automation. Provide the implementation with
`Effect.provide(AWS.Chatbot.DescribeSlackUserIdentitiesHttp)`.
### Slack Identity Management
**Example:** List linked Slack user identities
```typescript
const describeSlackUserIdentities =
  yield* AWS.Chatbot.DescribeSlackUserIdentities();
const result = yield* describeSlackUserIdentities();
const users = (result.SlackUserIdentities ?? []).map((u) => u.SlackUserId);
```

@binding

## DescribeSlackWorkspaces

Runtime binding for `chatbot:DescribeSlackWorkspaces`.

Lists the Slack workspaces authorized with AWS Chatbot in the account —
useful for identity/workspace audit automation. Provide the
implementation with
`Effect.provide(AWS.Chatbot.DescribeSlackWorkspacesHttp)`.
### Slack Identity Management
**Example:** List authorized Slack workspaces
```typescript
const describeSlackWorkspaces =
  yield* AWS.Chatbot.DescribeSlackWorkspaces();
const result = yield* describeSlackWorkspaces();
const teamIds = (result.SlackWorkspaces ?? []).map((w) => w.SlackTeamId);
```

@binding

## GetAccountPreferences

Runtime binding for `chatbot:GetAccountPreferences`.

Returns the account-level AWS Chatbot preferences (whether user-level
authorization is required and whether training-data collection is
enabled). Provide the implementation with
`Effect.provide(AWS.Chatbot.GetAccountPreferencesHttp)`.
### Account Preferences
**Example:** Read the account preferences
```typescript
const getAccountPreferences = yield* AWS.Chatbot.GetAccountPreferences();
const result = yield* getAccountPreferences();
const trainingData = result.AccountPreferences?.TrainingDataCollectionEnabled;
```

@binding

## ListMicrosoftTeamsConfiguredTeams

Runtime binding for `chatbot:ListMicrosoftTeamsConfiguredTeams`.

Lists the Microsoft Teams teams onboarded to AWS Chatbot in the account —
useful for identity/team audit automation. Provide the implementation
with `Effect.provide(AWS.Chatbot.ListMicrosoftTeamsConfiguredTeamsHttp)`.
### Microsoft Teams Identity Management
**Example:** List configured Microsoft Teams teams
```typescript
const listMicrosoftTeamsConfiguredTeams =
  yield* AWS.Chatbot.ListMicrosoftTeamsConfiguredTeams();
const result = yield* listMicrosoftTeamsConfiguredTeams();
const teamIds = (result.ConfiguredTeams ?? []).map((t) => t.TeamId);
```

@binding

## ListMicrosoftTeamsUserIdentities

Runtime binding for `chatbot:ListMicrosoftTeamsUserIdentities`.

Lists the Microsoft Teams user identities linked to AWS user identities,
optionally filtered to one channel configuration — the read half of
identity offboarding automation. Provide the implementation with
`Effect.provide(AWS.Chatbot.ListMicrosoftTeamsUserIdentitiesHttp)`.
### Microsoft Teams Identity Management
**Example:** List linked Teams user identities
```typescript
const listMicrosoftTeamsUserIdentities =
  yield* AWS.Chatbot.ListMicrosoftTeamsUserIdentities();
const result = yield* listMicrosoftTeamsUserIdentities();
const users = (result.TeamsUserIdentities ?? []).map((u) => u.UserId);
```

@binding

## UpdateAccountPreferences

Runtime binding for `chatbot:UpdateAccountPreferences`.

Updates the account-level AWS Chatbot preferences (user-level
authorization requirement, training-data collection). Provide the
implementation with
`Effect.provide(AWS.Chatbot.UpdateAccountPreferencesHttp)`.
### Account Preferences
**Example:** Require user authorization account-wide
```typescript
const updateAccountPreferences =
  yield* AWS.Chatbot.UpdateAccountPreferences();
yield* updateAccountPreferences({ UserAuthorizationRequired: true });
```

@binding
