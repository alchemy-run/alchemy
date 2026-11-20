<!-- Docs for the generated AWS.RePostSpace bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchAddChannelRoleToAccessors

Runtime binding for the `BatchAddChannelRoleToAccessors` operation (IAM
action `repostspace:BatchAddChannelRoleToAccessors` on the space ARN).

Grants a channel-level role (`ASKER`, `EXPERT`, `MODERATOR`, or
`SUPPORTREQUESTOR`) to up to 100 users or groups in a channel of the
bound {@link Space}. Per-accessor failures are reported in the output's
`errors` list rather than failing the whole call.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.BatchAddChannelRoleToAccessorsHttp)`.
### Managing Roles
**Example:** Grant a channel role to users
```typescript
const addChannelRole =
  yield* AWS.RePostSpace.BatchAddChannelRoleToAccessors(space);

const result = yield* addChannelRole({
  channelId,
  accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
  channelRole: "EXPERT",
});
```

@binding

## BatchAddRole

Runtime binding for the `BatchAddRole` operation (IAM action
`repostspace:BatchAddRole` on the space ARN).

Grants a space-level role (`EXPERT`, `MODERATOR`, `ADMINISTRATOR`, or
`SUPPORTREQUESTOR`) to up to 100 users or groups of the bound
{@link Space} in one call. Per-accessor failures are reported in the
output's `errors` list rather than failing the whole call.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.BatchAddRoleHttp)`.
### Managing Roles
**Example:** Grant the EXPERT role to users
```typescript
const batchAddRole = yield* AWS.RePostSpace.BatchAddRole(space);

const result = yield* batchAddRole({
  accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
  role: "EXPERT",
});
console.log(result.addedAccessorIds, result.errors);
```

@binding

## BatchRemoveChannelRoleFromAccessors

Runtime binding for the `BatchRemoveChannelRoleFromAccessors` operation
(IAM action `repostspace:BatchRemoveChannelRoleFromAccessors` on the
space ARN).

Removes a channel-level role from up to 100 users or groups in a channel
of the bound {@link Space}. Per-accessor failures are reported in the
output's `errors` list rather than failing the whole call.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.BatchRemoveChannelRoleFromAccessorsHttp)`.
### Managing Roles
**Example:** Remove a channel role from users
```typescript
const removeChannelRole =
  yield* AWS.RePostSpace.BatchRemoveChannelRoleFromAccessors(space);

const result = yield* removeChannelRole({
  channelId,
  accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
  channelRole: "EXPERT",
});
```

@binding

## BatchRemoveRole

Runtime binding for the `BatchRemoveRole` operation (IAM action
`repostspace:BatchRemoveRole` on the space ARN).

Removes a space-level role from up to 100 users or groups of the bound
{@link Space} in one call. Per-accessor failures are reported in the
output's `errors` list rather than failing the whole call.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.BatchRemoveRoleHttp)`.
### Managing Roles
**Example:** Remove the EXPERT role from users
```typescript
const batchRemoveRole = yield* AWS.RePostSpace.BatchRemoveRole(space);

const result = yield* batchRemoveRole({
  accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
  role: "EXPERT",
});
console.log(result.removedAccessorIds, result.errors);
```

@binding

## CreateChannel

Runtime binding for the `CreateChannel` operation (IAM action
`repostspace:CreateChannel` on the space ARN).

Creates a channel — a topic-scoped area for questions and articles —
inside the bound {@link Space}. Channels are content organization and
cannot be deleted (the re:Post Private API has no `DeleteChannel`), so
they are modeled as a runtime capability rather than a Resource.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.CreateChannelHttp)`.
### Managing Channels
**Example:** Create a channel in the private re:Post
```typescript
const createChannel = yield* AWS.RePostSpace.CreateChannel(space);

const { channelId } = yield* createChannel({
  channelName: "Networking",
  channelDescription: "VPC, DNS, and connectivity questions",
});
```

@binding

## DeregisterAdmin

Runtime binding for the `DeregisterAdmin` operation (IAM action
`repostspace:DeregisterAdmin` on the space ARN).

Removes administrator privileges from an IAM Identity Center user or
group (by accessor id) of the bound {@link Space}.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.DeregisterAdminHttp)`.
### Managing Admins
**Example:** Deregister a space administrator
```typescript
const deregisterAdmin = yield* AWS.RePostSpace.DeregisterAdmin(space);

yield* deregisterAdmin({ adminId: "94682c8d-1234-5678-9abc-e001c76e2c44" });
```

@binding

## GetChannel

Runtime binding for the `GetChannel` operation (IAM action
`repostspace:GetChannel` on the space ARN).

Reads a channel of the bound {@link Space} — its name, description,
status, and per-accessor channel roles.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.GetChannelHttp)`.
### Managing Channels
**Example:** Read a channel
```typescript
const getChannel = yield* AWS.RePostSpace.GetChannel(space);

const channel = yield* getChannel({ channelId });
console.log(channel.channelName, channel.channelStatus);
```

@binding

## ListChannels

Runtime binding for the `ListChannels` operation (IAM action
`repostspace:ListChannels` on the space ARN).

Lists the channels of the bound {@link Space}, one page per call
(`nextToken`/`maxResults`).
Provide the implementation with
`Effect.provide(AWS.RePostSpace.ListChannelsHttp)`.
### Managing Channels
**Example:** List the space's channels
```typescript
const listChannels = yield* AWS.RePostSpace.ListChannels(space);

const { channels } = yield* listChannels();
```

@binding

## RegisterAdmin

Runtime binding for the `RegisterAdmin` operation (IAM action
`repostspace:RegisterAdmin` on the space ARN).

Promotes an IAM Identity Center user or group (by accessor id) to
administrator of the bound {@link Space}.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.RegisterAdminHttp)`.
### Managing Admins
**Example:** Register a space administrator
```typescript
const registerAdmin = yield* AWS.RePostSpace.RegisterAdmin(space);

yield* registerAdmin({ adminId: "94682c8d-1234-5678-9abc-e001c76e2c44" });
```

@binding

## SendInvites

Runtime binding for the `SendInvites` operation (IAM action
`repostspace:SendInvites` on the space ARN).

Sends invitation emails (with a custom title and body) to users or
groups of the bound {@link Space}, identified by their IAM Identity
Center accessor ids.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.SendInvitesHttp)`.
### Inviting Users
**Example:** Invite users to the private re:Post
```typescript
const sendInvites = yield* AWS.RePostSpace.SendInvites(space);

yield* sendInvites({
  accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
  title: "Join our internal re:Post",
  body: "Ask and answer questions about our AWS workloads.",
});
```

@binding

## UpdateChannel

Runtime binding for the `UpdateChannel` operation (IAM action
`repostspace:UpdateChannel` on the space ARN).

Renames a channel of the bound {@link Space} and/or updates its
description.
Provide the implementation with
`Effect.provide(AWS.RePostSpace.UpdateChannelHttp)`.
### Managing Channels
**Example:** Rename a channel
```typescript
const updateChannel = yield* AWS.RePostSpace.UpdateChannel(space);

yield* updateChannel({
  channelId,
  channelName: "Networking & DNS",
});
```

@binding
