<!-- Docs for the generated AWS.SES bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetMetricData

Runtime binding for `sesv2:BatchGetMetricData`.

Fetches up to 10 aggregated deliverability metric time-series in one call —
sends, deliveries, bounces, complaints, opens, clicks — over a date range,
optionally sliced by dimension (ISP, configuration set, etc.). Requires VDM
(Virtual Deliverability Manager) to be enabled; a malformed query surfaces
the typed `BadRequestException`. Account-level operation. Provide the
implementation with `Effect.provide(AWS.SES.BatchGetMetricDataHttp)`.
### Deliverability Insights
**Example:** Query Send and Delivery Counts
```typescript
// init — account-level binding, no resource argument
const getMetrics = yield* SES.BatchGetMetricData();

// runtime
const { Results } = yield* getMetrics({
  Queries: [
    {
      Id: "sends",
      Namespace: "VDM",
      Metric: "SEND",
      StartDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
      EndDate: new Date(),
    },
  ],
});
```

@binding

## DeleteSuppressedDestination

Runtime binding for `sesv2:DeleteSuppressedDestination`.

Removes an email address from the account-level suppression list — e.g.
after a recipient re-subscribes or a bounce is resolved. Fails with the
typed `NotFoundException` tag when the address is not on the list.
Account-level operation. Provide the implementation with
`Effect.provide(AWS.SES.DeleteSuppressedDestinationHttp)`.
### Suppression List
**Example:** Unsuppress an Address
```typescript
// init — account-level binding, no resource argument
const unsuppress = yield* SES.DeleteSuppressedDestination();

// runtime
yield* unsuppress({ EmailAddress: "resubscribed@example.com" }).pipe(
  Effect.catchTag("NotFoundException", () => Effect.void),
);
```

@binding

## GetAccount

Runtime binding for `sesv2:GetAccount`.

Retrieves the SES account's sending status in the current region — the
send quota, whether sending is enabled, and whether the account has
production access (or is still in the sandbox). Useful to check remaining
quota before a large send. Account-level operation — invoked with no
arguments. Provide the implementation with
`Effect.provide(AWS.SES.GetAccountHttp)`.
### Account Status
**Example:** Check Quota and Sandbox Status
```typescript
// init — account-level binding, no resource argument
const getAccount = yield* SES.GetAccount();

// runtime
const account = yield* getAccount();
// account.SendQuota?.Max24HourSend, account.ProductionAccessEnabled
```

@binding

## GetBlacklistReports

Runtime binding for `sesv2:GetBlacklistReports`.

Retrieves, per dedicated-IP address, the list of anti-spam blacklists (RBLs)
that IP currently appears on, with the observation time. Useful for a
reputation dashboard over the account's dedicated IPs. Account-level
operation. Provide the implementation with
`Effect.provide(AWS.SES.GetBlacklistReportsHttp)`.
### Deliverability Insights
**Example:** Check Blacklist Status for Dedicated IPs
```typescript
// init — account-level binding, no resource argument
const getBlacklists = yield* SES.GetBlacklistReports();

// runtime — the dedicated IP addresses to check
const { BlacklistReport } = yield* getBlacklists({
  BlacklistItemNames: ["192.0.2.1"],
});
```

@binding

## GetDomainStatisticsReport

Runtime binding for `sesv2:GetDomainStatisticsReport`.

Retrieves inbox-placement and engagement statistics for a domain identity
over a date range — the data behind the SES deliverability dashboard.
Requires the deliverability dashboard subscription; an unknown domain
surfaces the typed `NotFoundException`. Account-level operation. Provide the
implementation with `Effect.provide(AWS.SES.GetDomainStatisticsReportHttp)`.
### Deliverability Insights
**Example:** Read a Domain's Deliverability Report
```typescript
// init — account-level binding, no resource argument
const getReport = yield* SES.GetDomainStatisticsReport();

// runtime
const report = yield* getReport({
  Domain: "example.com",
  StartDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
  EndDate: new Date(),
});
```

@binding

## GetMessageInsights

Runtime binding for `sesv2:GetMessageInsights`.

Retrieves the delivery insights SES tracked for a single sent message —
the per-recipient event timeline (send, delivery, open, click, bounce,
complaint) plus the resolved subject, from-address, and tags. Requires VDM
(Virtual Deliverability Manager) to be enabled and the message to have been
sent within the retention window; an unknown message id fails with the
typed `NotFoundException`. Account-level operation. Provide the
implementation with `Effect.provide(AWS.SES.GetMessageInsightsHttp)`.
### Deliverability Insights
**Example:** Look Up a Message's Delivery Timeline
```typescript
// init — account-level binding, no resource argument
const getInsights = yield* SES.GetMessageInsights();

// runtime — MessageId returned by a prior SendEmail
const { Insights } = yield* getInsights({ MessageId: messageId });
```

@binding

## GetSuppressedDestination

Runtime binding for `sesv2:GetSuppressedDestination`.

Retrieves a specific address from the account-level suppression list —
check whether (and why) an address is suppressed before attempting a
send. Fails with the typed `NotFoundException` tag when the address is
not on the list. Account-level operation. Provide the implementation with
`Effect.provide(AWS.SES.GetSuppressedDestinationHttp)`.
### Suppression List
**Example:** Look Up a Suppressed Address
```typescript
// init — account-level binding, no resource argument
const getSuppressed = yield* SES.GetSuppressedDestination();

// runtime
const { SuppressedDestination } = yield* getSuppressed({
  EmailAddress: "bouncing@example.com",
});
// SuppressedDestination.Reason — "BOUNCE" | "COMPLAINT"
```

@binding

## ListSuppressedDestinations

Runtime binding for `sesv2:ListSuppressedDestinations`.

Lists the addresses on the account-level suppression list, optionally
filtered by reason and date range. Account-level operation. Provide the
implementation with
`Effect.provide(AWS.SES.ListSuppressedDestinationsHttp)`.
### Suppression List
**Example:** List Bounce-Suppressed Addresses
```typescript
// init — account-level binding, no resource argument
const listSuppressed = yield* SES.ListSuppressedDestinations();

// runtime
const { SuppressedDestinationSummaries } = yield* listSuppressed({
  Reasons: ["BOUNCE"],
});
```

@binding

## PutSuppressedDestination

Runtime binding for `sesv2:PutSuppressedDestination`.

Adds an email address to the account-level suppression list — the
data-plane half of bounce/complaint handling: consume feedback events and
suppress the offending address so SES never attempts it again.
Account-level operation. Provide the implementation with
`Effect.provide(AWS.SES.PutSuppressedDestinationHttp)`.
### Suppression List
**Example:** Suppress a Hard-Bouncing Address
```typescript
// init — account-level binding, no resource argument
const suppress = yield* SES.PutSuppressedDestination();

// runtime
yield* suppress({
  EmailAddress: "bouncing@example.com",
  Reason: "BOUNCE",
});
```

@binding

## SendBounce

Runtime binding for `ses:SendBounce` (classic SES).

Generates and sends a bounce message to the sender of an email you received
through SES receiving — the data-plane counterpart to `SES.ReceiptRule`
inbound processing. You can only bounce a message within 24 hours of
receiving it, and only for mail SES actually received.

Account-level operation with no resource-level IAM scoping. Provide the
implementation with `Effect.provide(AWS.SES.SendBounceHttp)`.
### Bouncing Inbound Mail
**Example:** Bounce a Received Message
```typescript
// init — account-level binding, no resource argument
const sendBounce = yield* SES.SendBounce();

// runtime — inside the Lambda that a ReceiptRule invokes
yield* sendBounce({
  OriginalMessageId: messageId,
  BounceSender: "mailer-daemon@example.com",
  BouncedRecipientInfoList: [
    {
      Recipient: "nobody@example.com",
      BounceType: "DoesNotExist",
    },
  ],
});
```

@binding
