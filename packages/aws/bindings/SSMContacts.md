<!-- Docs for the generated AWS.SSMContacts bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptPage

Runtime binding for `ssm-contacts:AcceptPage`.

Acknowledge a page with the accept code Incident Manager delivered to
the contact's channel — `READ` marks it seen, `DELIVERED` confirms
receipt. Acknowledging stops further escalation stages.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.AcceptPageHttp)`.
### Working with Pages
**Example:** Acknowledge a Page
```typescript
const acceptPage = yield* AWS.SSMContacts.AcceptPage();

yield* acceptPage({
  PageId: pageArn,
  AcceptType: "READ",
  AcceptCode: "425440",
});
```

@binding

## ActivateContactChannel

Runtime binding for `ssm-contacts:ActivateContactChannel`.

Activate the bound contact channel with the code its owner received,
so Incident Manager can page through it. The channel's ARN is injected
as `ContactChannelId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ActivateContactChannelHttp)`.
### Activating Contact Channels
**Example:** Activate a Channel with the Received Code
```typescript
const activateContactChannel = yield* AWS.SSMContacts.ActivateContactChannel(email);

yield* activateContactChannel({ ActivationCode: "466136" });
```

@binding

## CreateRotationOverride

Runtime binding for `ssm-contacts:CreateRotationOverride`.

Temporarily override who is on call in the bound rotation — e.g. cover
a shift while the scheduled contact is unavailable. The rotation's ARN
is injected as `RotationId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.CreateRotationOverrideHttp)`.
### Managing On-Call Rotations
**Example:** Cover the Next Eight Hours
```typescript
const createRotationOverride =
  yield* AWS.SSMContacts.CreateRotationOverride(rotation);

const { RotationOverrideId } = yield* createRotationOverride({
  NewContactIds: [standbyContactArn],
  StartTime: new Date(),
  EndTime: new Date(Date.now() + 8 * 60 * 60 * 1000),
});
```

@binding

## DeactivateContactChannel

Runtime binding for `ssm-contacts:DeactivateContactChannel`.

Deactivate the bound contact channel so Incident Manager stops paging
through it — e.g. while the owner is on leave. The channel's ARN is
injected as `ContactChannelId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.DeactivateContactChannelHttp)`.
### Activating Contact Channels
**Example:** Deactivate a Channel
```typescript
const deactivateContactChannel = yield* AWS.SSMContacts.DeactivateContactChannel(email);

yield* deactivateContactChannel();
```

@binding

## DeleteRotationOverride

Runtime binding for `ssm-contacts:DeleteRotationOverride`.

Delete a rotation override of the bound rotation, restoring the
regular schedule. The rotation's ARN is injected as `RotationId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.DeleteRotationOverrideHttp)`.
### Managing On-Call Rotations
**Example:** Remove an Override
```typescript
const deleteRotationOverride =
  yield* AWS.SSMContacts.DeleteRotationOverride(rotation);

yield* deleteRotationOverride({ RotationOverrideId: overrideId });
```

@binding

## DescribeEngagement

Runtime binding for `ssm-contacts:DescribeEngagement`.

Read the details of an engagement — sender, subject, content, and the
incident it belongs to.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.DescribeEngagementHttp)`.
### Managing Engagements
**Example:** Inspect an Engagement
```typescript
const describeEngagement = yield* AWS.SSMContacts.DescribeEngagement();

const engagement = yield* describeEngagement({ EngagementId: engagementArn });
// engagement.Subject, engagement.ContactArn, ...
```

@binding

## DescribePage

Runtime binding for `ssm-contacts:DescribePage`.

Read the details of a page — the engagement it belongs to, its subject
and content, and delivery/read timestamps.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.DescribePageHttp)`.
### Working with Pages
**Example:** Inspect a Page
```typescript
const describePage = yield* AWS.SSMContacts.DescribePage();

const page = yield* describePage({ PageId: pageArn });
// page.SentTime, page.ReadTime, page.DeliveryTime, ...
```

@binding

## GetRotationOverride

Runtime binding for `ssm-contacts:GetRotationOverride`.

Read a rotation override of the bound rotation — its replacement
contacts and time window. The rotation's ARN is injected as
`RotationId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.GetRotationOverrideHttp)`.
### Managing On-Call Rotations
**Example:** Inspect an Override
```typescript
const getRotationOverride = yield* AWS.SSMContacts.GetRotationOverride(rotation);

const override = yield* getRotationOverride({
  RotationOverrideId: overrideId,
});
```

@binding

## ListEngagements

Runtime binding for `ssm-contacts:ListEngagements`.

List all engagements that have happened in the account, optionally
filtered by incident or time range.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListEngagementsHttp)`.
### Managing Engagements
**Example:** List Recent Engagements
```typescript
const listEngagements = yield* AWS.SSMContacts.ListEngagements();

const { Engagements } = yield* listEngagements();
```

@binding

## ListPageReceipts

Runtime binding for `ssm-contacts:ListPageReceipts`.

List the delivery/read receipts of a page — one receipt per contact
channel the page was sent over.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListPageReceiptsHttp)`.
### Working with Pages
**Example:** Check Whether a Page Was Read
```typescript
const listPageReceipts = yield* AWS.SSMContacts.ListPageReceipts();

const { Receipts } = yield* listPageReceipts({ PageId: pageArn });
// receipts with ReceiptType "READ" mean the page was acknowledged
```

@binding

## ListPageResolutions

Runtime binding for `ssm-contacts:ListPageResolutions`.

List the resolution path of a page — the chain of escalation-plan and
on-call-schedule hops that led Incident Manager to the engaged contact.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListPageResolutionsHttp)`.
### Working with Pages
**Example:** Trace How a Contact Was Paged
```typescript
const listPageResolutions = yield* AWS.SSMContacts.ListPageResolutions();

const { PageResolutions } = yield* listPageResolutions({ PageId: pageArn });
```

@binding

## ListPagesByContact

Runtime binding for `ssm-contacts:ListPagesByContact`.

List the pages (individual engagement deliveries) sent to the bound
contact. The contact's ARN is injected as `ContactId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListPagesByContactHttp)`.
### Working with Pages
**Example:** List Pages Sent to a Contact
```typescript
const listPagesByContact = yield* AWS.SSMContacts.ListPagesByContact(oncall);

const { Pages } = yield* listPagesByContact();
```

@binding

## ListPagesByEngagement

Runtime binding for `ssm-contacts:ListPagesByEngagement`.

List the pages an engagement produced — one page per engaged contact
and escalation stage.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListPagesByEngagementHttp)`.
### Working with Pages
**Example:** List an Engagement's Pages
```typescript
const listPagesByEngagement = yield* AWS.SSMContacts.ListPagesByEngagement();

const { Pages } = yield* listPagesByEngagement({ EngagementId: engagementArn });
```

@binding

## ListPreviewRotationShifts

Runtime binding for `ssm-contacts:ListPreviewRotationShifts`.

Preview the shifts a hypothetical rotation configuration would produce
before creating or updating a rotation. Takes members, a time zone,
and recurrence settings directly, so it is account-scoped.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListPreviewRotationShiftsHttp)`.
### Managing On-Call Rotations
**Example:** Preview a Rotation Schedule
```typescript
const listPreviewRotationShifts =
  yield* AWS.SSMContacts.ListPreviewRotationShifts();

const { RotationShifts } = yield* listPreviewRotationShifts({
  EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  Members: ["alice", "bob"],
  TimeZoneId: "America/Los_Angeles",
  Recurrence: {
    NumberOfOnCalls: 1,
    RecurrenceMultiplier: 1,
    DailySettings: [{ HourOfDay: 9, MinuteOfHour: 0 }],
  },
});
```

@binding

## ListRotationOverrides

Runtime binding for `ssm-contacts:ListRotationOverrides`.

List the rotation overrides of the bound rotation in a time window.
The rotation's ARN is injected as `RotationId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListRotationOverridesHttp)`.
### Managing On-Call Rotations
**Example:** List Overrides This Week
```typescript
const listRotationOverrides =
  yield* AWS.SSMContacts.ListRotationOverrides(rotation);

const { RotationOverrides } = yield* listRotationOverrides({
  StartTime: new Date(),
  EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
});
```

@binding

## ListRotationShifts

Runtime binding for `ssm-contacts:ListRotationShifts`.

List the bound rotation's shifts in a time window — who is (or will
be) on call and when. The rotation's ARN is injected as `RotationId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.ListRotationShiftsHttp)`.
### Managing On-Call Rotations
**Example:** Who Is On Call This Week
```typescript
const listRotationShifts = yield* AWS.SSMContacts.ListRotationShifts(rotation);

const { RotationShifts } = yield* listRotationShifts({
  EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
});
```

@binding

## SendActivationCode

Runtime binding for `ssm-contacts:SendActivationCode`.

Send (or re-send) the activation code to the bound contact channel's
address. The channel owner passes the code to `ActivateContactChannel`
to confirm the channel. The channel's ARN is injected as
`ContactChannelId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.SendActivationCodeHttp)`.
### Activating Contact Channels
**Example:** Send the Activation Code
```typescript
const sendActivationCode = yield* AWS.SSMContacts.SendActivationCode(email);

// runtime — e.g. behind a "resend code" button
yield* sendActivationCode();
```

@binding

## StartEngagement

Runtime binding for `ssm-contacts:StartEngagement`.

Page the bound contact (or run its escalation plan) — Incident Manager
works through the contact's engagement plan, sending the subject and
content over each stage's channels until the page is acknowledged. The
contact's ARN is injected as `ContactId`.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.StartEngagementHttp)`.
### Starting Engagements
**Example:** Page the On-Call Contact
```typescript
// init — bind the operation to the contact
const startEngagement = yield* AWS.SSMContacts.StartEngagement(oncall);

// runtime — page the contact when an alert fires
const { EngagementArn } = yield* startEngagement({
  Sender: "alert-bot",
  Subject: "Database CPU at 95%",
  Content: "Primary DB is saturated - please investigate.",
});
```

@binding

## StopEngagement

Runtime binding for `ssm-contacts:StopEngagement`.

Stop a running engagement, halting any further stages of the contact's
engagement plan — e.g. once the incident is acknowledged or resolved.
Engagement ARNs are minted at runtime by `StartEngagement`, so this
binding is account-scoped.
Provide the implementation with
`Effect.provide(AWS.SSMContacts.StopEngagementHttp)`.
### Managing Engagements
**Example:** Stop an Engagement After Resolution
```typescript
const stopEngagement = yield* AWS.SSMContacts.StopEngagement();

yield* stopEngagement({
  EngagementId: engagementArn,
  Reason: "incident resolved",
});
```

@binding
