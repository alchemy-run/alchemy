<!-- Docs for the generated AWS.Notifications bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetManagedNotificationChildEvent

Runtime binding for `notifications:GetManagedNotificationChildEvent`.

Fetch one child event of an aggregated AWS-managed notification (e.g. a
single account/region item inside an aggregate AWS Health event) by its
ARN. Provide the implementation with
`Effect.provide(AWS.Notifications.GetManagedNotificationChildEventHttp)`.
### Reading AWS-Managed Notifications
**Example:** Fetch a Managed Notification Child Event
```typescript
// init — account-level binding takes no resource
const getManagedNotificationChildEvent =
  yield* AWS.Notifications.GetManagedNotificationChildEvent();

// runtime
const child = yield* getManagedNotificationChildEvent({ arn: childArn });
```

@binding

## GetManagedNotificationChildEvent.Request

Request for {@link GetManagedNotificationChildEvent}.

## GetManagedNotificationConfiguration

Runtime binding for `notifications:GetManagedNotificationConfiguration`.

Fetch one AWS-managed notification configuration (the AWS Health
Security/Operations/Issue/Billing categories) by its ARN. Provide the
implementation with
`Effect.provide(AWS.Notifications.GetManagedNotificationConfigurationHttp)`.
### Reading AWS-Managed Notifications
**Example:** Fetch a Managed Notification Configuration
```typescript
// init — account-level binding takes no resource
const getManagedNotificationConfiguration =
  yield* AWS.Notifications.GetManagedNotificationConfiguration();

// runtime
const config = yield* getManagedNotificationConfiguration({
  arn: managedConfigArn,
});
```

@binding

## GetManagedNotificationConfiguration.Request

Request for {@link GetManagedNotificationConfiguration}.

## GetManagedNotificationEvent

Runtime binding for `notifications:GetManagedNotificationEvent`.

Fetch one AWS-managed notification event (AWS Health security,
operations, billing and issue notifications) by its ARN. Provide the
implementation with
`Effect.provide(AWS.Notifications.GetManagedNotificationEventHttp)`.
### Reading AWS-Managed Notifications
**Example:** Fetch a Managed Notification Event
```typescript
// init — account-level binding takes no resource
const getManagedNotificationEvent =
  yield* AWS.Notifications.GetManagedNotificationEvent();

// runtime
const event = yield* getManagedNotificationEvent({ arn: eventArn });
const headline = event.content.messageComponents.headline;
```

@binding

## GetManagedNotificationEvent.Request

Request for {@link GetManagedNotificationEvent}.

## GetNotificationEvent

Runtime binding for `notifications:GetNotificationEvent`.

Fetch one notification event (headline, message components, source event
metadata) by its ARN. Provide the implementation with
`Effect.provide(AWS.Notifications.GetNotificationEventHttp)`.
### Reading Notification Events
**Example:** Fetch a Notification Event
```typescript
// init — account-level binding takes no resource
const getNotificationEvent = yield* AWS.Notifications.GetNotificationEvent();

// runtime
const event = yield* getNotificationEvent({ arn: eventArn });
const headline = event.content.messageComponents.headline;
```

@binding

## GetNotificationEvent.Request

Request for {@link GetNotificationEvent}.

## ListChannels

Runtime binding for `notifications:ListChannels`.

List the delivery channel ARNs associated with a notification
configuration. Provide the implementation with
`Effect.provide(AWS.Notifications.ListChannelsHttp)`.
### Reading Configuration Channels
**Example:** List a Configuration's Channels
```typescript
// init — bind the operation to the configuration
const listChannels = yield* AWS.Notifications.ListChannels(config);

// runtime
const result = yield* listChannels();
const channelArns = result.channels;
```

@binding

## ListChannels.Request

Request for {@link ListChannels} — the bound configuration's ARN is
injected automatically.

## ListManagedNotificationChildEvents

Runtime binding for `notifications:ListManagedNotificationChildEvents`.

List the child events of one aggregated AWS-managed notification event.
Provide the implementation with
`Effect.provide(AWS.Notifications.ListManagedNotificationChildEventsHttp)`.
### Reading AWS-Managed Notifications
**Example:** List an Aggregate Event's Children
```typescript
// init — account-level binding takes no resource
const listManagedNotificationChildEvents =
  yield* AWS.Notifications.ListManagedNotificationChildEvents();

// runtime
const result = yield* listManagedNotificationChildEvents({
  aggregateManagedNotificationEventArn: aggregateArn,
});
const children = result.managedNotificationChildEvents;
```

@binding

## ListManagedNotificationChildEvents.Request

Request for {@link ListManagedNotificationChildEvents}.

## ListManagedNotificationEvents

Runtime binding for `notifications:ListManagedNotificationEvents`.

List the account's AWS-managed notification events (AWS Health security,
operations, billing and issue notifications), optionally filtered by time
range, source, or related account. Provide the implementation with
`Effect.provide(AWS.Notifications.ListManagedNotificationEventsHttp)`.
### Reading AWS-Managed Notifications
**Example:** List Recent Managed Notification Events
```typescript
// init — account-level binding takes no resource
const listManagedNotificationEvents =
  yield* AWS.Notifications.ListManagedNotificationEvents();

// runtime
const result = yield* listManagedNotificationEvents({
  startTime: new Date(Date.now() - 7 * 24 * 3600 * 1000),
});
const count = result.managedNotificationEvents.length;
```

@binding

## ListManagedNotificationEvents.Request

Request for {@link ListManagedNotificationEvents}.

## ListNotificationEvents

Runtime binding for `notifications:ListNotificationEvents`.

List the account's notification events, optionally filtered by time
range, EventBridge source, or aggregate parent event. Provide the
implementation with
`Effect.provide(AWS.Notifications.ListNotificationEventsHttp)`.
### Reading Notification Events
**Example:** List Recent Notification Events
```typescript
// init — account-level binding takes no resource
const listNotificationEvents = yield* AWS.Notifications.ListNotificationEvents();

// runtime
const result = yield* listNotificationEvents({ source: "aws.s3" });
const headlines = result.notificationEvents.map(
  (e) => e.notificationEvent.messageComponents.headline,
);
```

@binding

## ListNotificationEvents.Request

Request for {@link ListNotificationEvents}.
