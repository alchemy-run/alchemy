<!-- Docs for the generated AWS.SNS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AddPermission

Runtime binding for `sns:AddPermission`.

Bind this operation to a {@link Topic} inside a function runtime to grant
other AWS accounts access to topic actions by adding a labeled statement
to the topic's access policy. The binding grants the host function
`sns:AddPermission` on the topic. Provide the `AddPermissionHttp` layer on
the Function to implement the binding.
### Managing Topic Permissions
**Example:** Allow Another Account to Publish
```typescript
// init (provide SNS.AddPermissionHttp on the Function)
const addPermission = yield* SNS.AddPermission(topic);

// runtime
yield* addPermission({
  Label: "PartnerPublish",
  AWSAccountId: ["123456789012"],
  ActionName: ["Publish"],
});
```

@binding

## CheckIfPhoneNumberIsOptedOut

Runtime binding for `sns:CheckIfPhoneNumberIsOptedOut`.

An account-scoped operation — reports whether SMS delivery to a phone
number is blocked because its owner opted out.
Provide the `CheckIfPhoneNumberIsOptedOutHttp` layer on the Function to implement the binding.
### SMS Opt-Out Management
**Example:** Check an Opt-Out
```typescript
const checkOptOut = yield* SNS.CheckIfPhoneNumberIsOptedOut();
const { isOptedOut } = yield* checkOptOut({ phoneNumber: "+15555550123" });
```

@binding

## ConfirmSubscription

Runtime binding for `sns:ConfirmSubscription`.

Bind this operation to a {@link Subscription} inside a function runtime to
confirm a pending subscription with the token SNS delivered to the
endpoint (e.g. from an `https` or `email` confirmation message). The
binding grants the host function `sns:ConfirmSubscription` on the topic.
Provide the `ConfirmSubscriptionHttp` layer on the Function to implement
the binding.
### Confirming Subscriptions
**Example:** Confirm with a Delivered Token
```typescript
// init (provide SNS.ConfirmSubscriptionHttp on the Function)
const confirmSubscription = yield* SNS.ConfirmSubscription(subscription);

// runtime: token comes from the SubscriptionConfirmation message
const response = yield* confirmSubscription({ Token: token });
// response.SubscriptionArn
```

@binding

## CreatePlatformEndpoint

Runtime binding for `sns:CreatePlatformEndpoint`.

Bind this operation to a {@link PlatformApplication} to register device
push tokens at runtime. The `PlatformApplicationArn` is injected
automatically; the call is idempotent per token.
Provide the `CreatePlatformEndpointHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** Register a Device Token
```typescript
const createEndpoint = yield* SNS.CreatePlatformEndpoint(app);
const endpoint = yield* createEndpoint({ Token: deviceToken });
```

@binding

## CreateSMSSandboxPhoneNumber

Runtime binding for `sns:CreateSMSSandboxPhoneNumber`.

An account-scoped operation — registers a destination phone number in
the SMS sandbox, which sends it a one-time verification code.
Provide the `CreateSMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
### SMS Sandbox
**Example:** Register a Sandbox Number
```typescript
const createSandboxNumber = yield* SNS.CreateSMSSandboxPhoneNumber();
yield* createSandboxNumber({ PhoneNumber: "+15555550123" });
```

@binding

## DeleteEndpoint

Runtime binding for `sns:DeleteEndpoint`.

Bind this operation to a {@link PlatformApplication} to deregister one
of its device endpoints (idempotent).
Provide the `DeleteEndpointHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** Delete an Endpoint
```typescript
const deleteEndpoint = yield* SNS.DeleteEndpoint(app);
yield* deleteEndpoint({ EndpointArn: endpointArn });
```

@binding

## DeleteSMSSandboxPhoneNumber

Runtime binding for `sns:DeleteSMSSandboxPhoneNumber`.

An account-scoped operation — removes a destination phone number from
the account's SMS sandbox.
Provide the `DeleteSMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
### SMS Sandbox
**Example:** Delete a Sandbox Number
```typescript
const deleteSandboxNumber = yield* SNS.DeleteSMSSandboxPhoneNumber();
yield* deleteSandboxNumber({ PhoneNumber: "+15555550123" });
```

@binding

## GetDataProtectionPolicy

Runtime binding for `sns:GetDataProtectionPolicy`.

Bind this operation to a {@link Topic} inside a function runtime to read
the topic's data protection policy document; the `ResourceArn` is injected
automatically. The binding grants the host function
`sns:GetDataProtectionPolicy` on the topic. Provide the
`GetDataProtectionPolicyHttp` layer on the Function to implement the
binding.
### Data Protection Policies
**Example:** Read the Data Protection Policy
```typescript
// init (provide SNS.GetDataProtectionPolicyHttp on the Function)
const getDataProtectionPolicy = yield* SNS.GetDataProtectionPolicy(topic);

// runtime
const response = yield* getDataProtectionPolicy();
// response.DataProtectionPolicy (JSON document string)
```

@binding

## GetEndpointAttributes

Runtime binding for `sns:GetEndpointAttributes`.

Bind this operation to a {@link PlatformApplication} to read the
attributes (`Token`, `Enabled`, `CustomUserData`) of one of its device
endpoints.
Provide the `GetEndpointAttributesHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** Read Endpoint Attributes
```typescript
const getEndpointAttributes = yield* SNS.GetEndpointAttributes(app);
const { Attributes } = yield* getEndpointAttributes({
  EndpointArn: endpointArn,
});
```

@binding

## GetSMSAttributes

Runtime binding for `sns:GetSMSAttributes`.

An account-scoped operation — reads the account-level SMS settings such
as `DefaultSMSType`, `MonthlySpendLimit`, and delivery-status sampling.
Provide the `GetSMSAttributesHttp` layer on the Function to implement the binding.
### SMS Account Settings
**Example:** Read SMS Settings
```typescript
const getSmsAttributes = yield* SNS.GetSMSAttributes();
const { attributes } = yield* getSmsAttributes();
```

@binding

## GetSMSSandboxAccountStatus

Runtime binding for `sns:GetSMSSandboxAccountStatus`.

An account-scoped operation — reports whether the account is still in
the SMS sandbox (only verified destination numbers deliverable).
Provide the `GetSMSSandboxAccountStatusHttp` layer on the Function to implement the binding.
### SMS Sandbox
**Example:** Check Sandbox Status
```typescript
const getSandboxStatus = yield* SNS.GetSMSSandboxAccountStatus();
const { IsInSandbox } = yield* getSandboxStatus();
```

@binding

## GetSubscriptionAttributes

Runtime binding for `sns:GetSubscriptionAttributes`.

Bind this operation to a {@link Subscription} inside a function runtime to
read the subscription's raw attribute map (filter policy, redrive policy,
raw message delivery, etc.). The binding grants the host function
`sns:GetSubscriptionAttributes` on the subscription. Provide the
`GetSubscriptionAttributesHttp` layer on the Function to implement the
binding.
### Reading Subscription Attributes
**Example:** Read a Subscription's Attributes
```typescript
// init (provide SNS.GetSubscriptionAttributesHttp on the Function)
const getSubscriptionAttributes =
  yield* SNS.GetSubscriptionAttributes(subscription);

// runtime
const response = yield* getSubscriptionAttributes();
const filterPolicy = response.Attributes?.FilterPolicy;
```

@binding

## GetTopicAttributes

Runtime binding for `sns:GetTopicAttributes`.

Bind this operation to a {@link Topic} inside a function runtime to read
the topic's raw attribute map (policy, delivery status, KMS key, etc.).
The binding grants the host function `sns:GetTopicAttributes` on the
topic. Provide the `GetTopicAttributesHttp` layer on the Function to
implement the binding.
### Reading Topic Attributes
**Example:** Read a Topic's Attributes
```typescript
// init (provide SNS.GetTopicAttributesHttp on the Function)
const getTopicAttributes = yield* SNS.GetTopicAttributes(topic);

// runtime
const response = yield* getTopicAttributes();
const displayName = response.Attributes?.DisplayName;
```

@binding

## ListEndpointsByPlatformApplication

Runtime binding for `sns:ListEndpointsByPlatformApplication`.

Bind this operation to a {@link PlatformApplication} to page through its
registered device endpoints.
Provide the `ListEndpointsByPlatformApplicationHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** List Device Endpoints
```typescript
const listEndpoints = yield* SNS.ListEndpointsByPlatformApplication(app);
const { Endpoints } = yield* listEndpoints();
```

@binding

## ListOriginationNumbers

Runtime binding for `sns:ListOriginationNumbers`.

An account-scoped operation — lists the origination phone numbers
available to send SMS from this account.
Provide the `ListOriginationNumbersHttp` layer on the Function to implement the binding.
### SMS Account Settings
**Example:** List Origination Numbers
```typescript
const listOriginationNumbers = yield* SNS.ListOriginationNumbers();
const { PhoneNumbers } = yield* listOriginationNumbers();
```

@binding

## ListPhoneNumbersOptedOut

Runtime binding for `sns:ListPhoneNumbersOptedOut`.

An account-scoped operation — pages through the phone numbers whose
owners opted out of receiving SMS from this account.
Provide the `ListPhoneNumbersOptedOutHttp` layer on the Function to implement the binding.
### SMS Opt-Out Management
**Example:** List Opted-Out Numbers
```typescript
const listOptedOut = yield* SNS.ListPhoneNumbersOptedOut();
const { phoneNumbers } = yield* listOptedOut();
```

@binding

## ListPlatformApplications

Runtime binding for `sns:ListPlatformApplications`.

An account-scoped operation — pages through the mobile-push platform
applications in the account/region.
Provide the `ListPlatformApplicationsHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** List Platform Applications
```typescript
const listApplications = yield* SNS.ListPlatformApplications();
const { PlatformApplications } = yield* listApplications();
```

@binding

## ListSMSSandboxPhoneNumbers

Runtime binding for `sns:ListSMSSandboxPhoneNumbers`.

An account-scoped operation — lists the destination phone numbers
registered (verified or pending) in the account's SMS sandbox.
Provide the `ListSMSSandboxPhoneNumbersHttp` layer on the Function to implement the binding.
### SMS Sandbox
**Example:** List Sandbox Numbers
```typescript
const listSandboxNumbers = yield* SNS.ListSMSSandboxPhoneNumbers();
const { PhoneNumbers } = yield* listSandboxNumbers();
```

@binding

## ListSubscriptions

Runtime binding for `sns:ListSubscriptions`.

An account-scoped operation — bind it with no arguments to page through
all subscriptions in the account/region. The binding grants the host
function `sns:ListSubscriptions`. Provide the `ListSubscriptionsHttp`
layer on the Function to implement the binding.

To list only the subscriptions of one topic, use
{@link ListSubscriptionsByTopic}.
### Listing Subscriptions
**Example:** List All Subscriptions
```typescript
// init (provide SNS.ListSubscriptionsHttp on the Function)
const listSubscriptions = yield* SNS.ListSubscriptions();

// runtime: pass NextToken to page through large accounts
const response = yield* listSubscriptions();
// response.Subscriptions
```

@binding

## ListSubscriptionsByTopic

Runtime binding for `sns:ListSubscriptionsByTopic`.

Bind this operation to a {@link Topic} inside a function runtime to page
through that topic's subscriptions; the `TopicArn` is injected
automatically. The binding grants the host function
`sns:ListSubscriptionsByTopic` on the topic. Provide the
`ListSubscriptionsByTopicHttp` layer on the Function to implement the
binding.
### Listing a Topic's Subscriptions
**Example:** List Subscriptions of a Topic
```typescript
// init (provide SNS.ListSubscriptionsByTopicHttp on the Function)
const listSubscriptionsByTopic = yield* SNS.ListSubscriptionsByTopic(topic);

// runtime
const response = yield* listSubscriptionsByTopic();
const endpoints = (response.Subscriptions ?? []).map((s) => s.Endpoint);
```

@binding

## ListTagsForResource

Runtime binding for `sns:ListTagsForResource`.

Bind this operation to a {@link Topic} inside a function runtime to read
the topic's tags; the `ResourceArn` is injected automatically. The binding
grants the host function `sns:ListTagsForResource` on the topic. Provide
the `ListTagsForResourceHttp` layer on the Function to implement the
binding.
### Tagging Topics
**Example:** List a Topic's Tags
```typescript
// init (provide SNS.ListTagsForResourceHttp on the Function)
const listTagsForResource = yield* SNS.ListTagsForResource(topic);

// runtime
const response = yield* listTagsForResource();
// response.Tags
```

@binding

## ListTopics

Runtime binding for `sns:ListTopics`.

An account-scoped operation — bind it with no arguments to page through
all topic ARNs in the account/region. The binding grants the host function
`sns:ListTopics`. Provide the `ListTopicsHttp` layer on the Function to
implement the binding.
### Listing Topics
**Example:** List Topic ARNs
```typescript
// init (provide SNS.ListTopicsHttp on the Function)
const listTopics = yield* SNS.ListTopics();

// runtime: pass NextToken to page through large accounts
const response = yield* listTopics();
const arns = (response.Topics ?? []).map((topic) => topic.TopicArn);
```

@binding

## OptInPhoneNumber

Runtime binding for `sns:OptInPhoneNumber`.

An account-scoped operation — opts a previously opted-out phone number
back in to SMS delivery (allowed once every 30 days per number).
Provide the `OptInPhoneNumberHttp` layer on the Function to implement the binding.
### SMS Opt-Out Management
**Example:** Opt a Number Back In
```typescript
const optIn = yield* SNS.OptInPhoneNumber();
yield* optIn({ phoneNumber: "+15555550123" });
```

@binding

## Publish

Runtime binding for `sns:Publish`.

Bind this operation to a {@link Topic} inside a function runtime to get a
callable that automatically injects the `TopicArn`. The binding grants the
host function `sns:Publish` on the topic. Provide the `PublishHttp` layer
on the Function to implement the binding.
### Publishing Messages
**Example:** Publish from a Lambda Function
```typescript
export class ApiFunction extends Lambda.Function<Lambda.Function>()(
  "ApiFunction",
) {}

export default ApiFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const topic = yield* SNS.Topic("Events");

    // init: bind the operation to the topic (grants sns:Publish)
    const publish = yield* SNS.Publish(topic);

    return {
      fetch: Effect.gen(function* () {
        // runtime: TopicArn is injected automatically
        const response = yield* publish({
          Message: "order shipped",
          Subject: "order-update",
        });
        return yield* HttpServerResponse.json({
          messageId: response.MessageId,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SNS.PublishHttp)),
);
```

@binding

## PublishBatch

Runtime binding for `sns:PublishBatch`.

Bind this operation to a {@link Topic} inside a function runtime to publish
up to 10 messages per call with per-entry success/failure results. The
binding grants the host function `sns:Publish` on the topic. Provide the
`PublishBatchHttp` layer on the Function to implement the binding.

For an unbounded stream of messages with automatic batching and bounded
retry of transient per-entry failures, prefer {@link TopicSink}.
### Publishing Message Batches
**Example:** Publish a Batch of Messages
```typescript
// init (provide SNS.PublishBatchHttp on the Function)
const publishBatch = yield* SNS.PublishBatch(topic);

// runtime
const response = yield* publishBatch({
  PublishBatchRequestEntries: messages.map((message, index) => ({
    Id: `${index}`,
    Message: message,
  })),
});
// response.Successful / response.Failed
```

@binding

## PublishSms

Runtime binding for `sns:Publish`.

Runtime binding for direct SMS delivery with `sns:Publish` — send a text
message straight to a phone number without a topic. Accounts start in the
SMS sandbox, where only verified destination numbers are deliverable.
Provide the `PublishSmsHttp` layer on the Function to implement the binding.
### Sending SMS
**Example:** Send a Text Message
```typescript
const publishSms = yield* SNS.PublishSms();
yield* publishSms({
  PhoneNumber: "+15555550123",
  Message: "Your code is 123456",
});
```

@binding

## PublishToEndpoint

Runtime binding for `sns:Publish`.

Runtime binding for `sns:Publish` targeting a mobile-push endpoint of a
{@link PlatformApplication}: pass the device `TargetArn` returned by
`CreatePlatformEndpoint`.
Provide the `PublishToEndpointHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** Push to a Device
```typescript
const publishToEndpoint = yield* SNS.PublishToEndpoint(app);
yield* publishToEndpoint({
  TargetArn: endpointArn,
  Message: "hello",
});
```

@binding

## PutDataProtectionPolicy

Runtime binding for `sns:PutDataProtectionPolicy`.

Bind this operation to a {@link Topic} inside a function runtime to attach
or replace the topic's data protection policy; the `ResourceArn` is
injected automatically. The binding grants the host function
`sns:PutDataProtectionPolicy` on the topic. Provide the
`PutDataProtectionPolicyHttp` layer on the Function to implement the
binding.
### Data Protection Policies
**Example:** Attach a Data Protection Policy
```typescript
// init (provide SNS.PutDataProtectionPolicyHttp on the Function)
const putDataProtectionPolicy = yield* SNS.PutDataProtectionPolicy(topic);

// runtime
yield* putDataProtectionPolicy({
  DataProtectionPolicy: JSON.stringify({
    Name: "basic-pii-audit",
    Version: "2021-06-01",
    Statement: [],
  }),
});
```

@binding

## RemovePermission

Runtime binding for `sns:RemovePermission`.

Bind this operation to a {@link Topic} inside a function runtime to remove
a policy statement previously added with {@link AddPermission} by its
label. The binding grants the host function `sns:RemovePermission` on the
topic. Provide the `RemovePermissionHttp` layer on the Function to
implement the binding.
### Managing Topic Permissions
**Example:** Remove a Permission by Label
```typescript
// init (provide SNS.RemovePermissionHttp on the Function)
const removePermission = yield* SNS.RemovePermission(topic);

// runtime
yield* removePermission({ Label: "PartnerPublish" });
```

@binding

## SetEndpointAttributes

Runtime binding for `sns:SetEndpointAttributes`.

Bind this operation to a {@link PlatformApplication} to update a device
endpoint — e.g. re-enable it after a delivery failure or rotate its token.
Provide the `SetEndpointAttributesHttp` layer on the Function to implement the binding.
### Mobile Push
**Example:** Re-enable an Endpoint
```typescript
const setEndpointAttributes = yield* SNS.SetEndpointAttributes(app);
yield* setEndpointAttributes({
  EndpointArn: endpointArn,
  Attributes: { Enabled: "true" },
});
```

@binding

## SetSMSAttributes

Runtime binding for `sns:SetSMSAttributes`.

An account-scoped operation — updates the account-level SMS settings,
e.g. switching the default message type between `Promotional` and
`Transactional`.
Provide the `SetSMSAttributesHttp` layer on the Function to implement the binding.
### SMS Account Settings
**Example:** Set the Default SMS Type
```typescript
const setSmsAttributes = yield* SNS.SetSMSAttributes();
yield* setSmsAttributes({
  attributes: { DefaultSMSType: "Transactional" },
});
```

@binding

## SetSubscriptionAttributes

Runtime binding for `sns:SetSubscriptionAttributes`.

Bind this operation to a {@link Subscription} inside a function runtime to
set a single subscription attribute by name (e.g. `FilterPolicy`,
`RawMessageDelivery`). The binding grants the host function
`sns:SetSubscriptionAttributes` on the subscription. Provide the
`SetSubscriptionAttributesHttp` layer on the Function to implement the
binding.
### Updating Subscription Attributes
**Example:** Set a Filter Policy
```typescript
// init (provide SNS.SetSubscriptionAttributesHttp on the Function)
const setSubscriptionAttributes =
  yield* SNS.SetSubscriptionAttributes(subscription);

// runtime
yield* setSubscriptionAttributes({
  AttributeName: "FilterPolicy",
  AttributeValue: JSON.stringify({ type: ["order"] }),
});
```

@binding

## SetTopicAttributes

Runtime binding for `sns:SetTopicAttributes`.

Bind this operation to a {@link Topic} inside a function runtime to set a
single topic attribute by name. The binding grants the host function
`sns:SetTopicAttributes` on the topic. Provide the
`SetTopicAttributesHttp` layer on the Function to implement the binding.
### Updating Topic Attributes
**Example:** Set a Topic's Display Name
```typescript
// init (provide SNS.SetTopicAttributesHttp on the Function)
const setTopicAttributes = yield* SNS.SetTopicAttributes(topic);

// runtime
yield* setTopicAttributes({
  AttributeName: "DisplayName",
  AttributeValue: "order-events",
});
```

@binding

## Subscribe

Runtime binding for `sns:Subscribe`.

Bind this operation to a {@link Topic} to subscribe endpoints (email,
sms, https, sqs, ...) to the topic at runtime — for example subscribing a
user's email address from an API handler. The `TopicArn` is injected
automatically.
Provide the `SubscribeHttp` layer on the Function to implement the binding.
### Subscribing Endpoints
**Example:** Subscribe an Email Address
```typescript
const subscribe = yield* SNS.Subscribe(topic);
const response = yield* subscribe({
  Protocol: "email",
  Endpoint: "user@example.com",
});
```

@binding

## TagResource

Runtime binding for `sns:TagResource`.

Bind this operation to a {@link Topic} inside a function runtime to add or
overwrite tags on the topic; the `ResourceArn` is injected automatically.
The binding grants the host function `sns:TagResource` on the topic.
Provide the `TagResourceHttp` layer on the Function to implement the
binding.
### Tagging Topics
**Example:** Tag a Topic
```typescript
// init (provide SNS.TagResourceHttp on the Function)
const tagResource = yield* SNS.TagResource(topic);

// runtime
yield* tagResource({
  Tags: [{ Key: "team", Value: "orders" }],
});
```

@binding

## Unsubscribe

Runtime binding for `sns:Unsubscribe`.

An account-scoped operation — deletes a subscription by ARN, e.g. one
created at runtime with the `Subscribe` binding.
Provide the `UnsubscribeHttp` layer on the Function to implement the binding.
### Unsubscribing
**Example:** Unsubscribe by ARN
```typescript
const unsubscribe = yield* SNS.Unsubscribe();
yield* unsubscribe({ SubscriptionArn: subscriptionArn });
```

@binding

## UntagResource

Runtime binding for `sns:UntagResource`.

Bind this operation to a {@link Topic} inside a function runtime to remove
tags from the topic by key; the `ResourceArn` is injected automatically.
The binding grants the host function `sns:UntagResource` on the topic.
Provide the `UntagResourceHttp` layer on the Function to implement the
binding.
### Tagging Topics
**Example:** Remove Tags from a Topic
```typescript
// init (provide SNS.UntagResourceHttp on the Function)
const untagResource = yield* SNS.UntagResource(topic);

// runtime
yield* untagResource({ TagKeys: ["team"] });
```

@binding

## VerifySMSSandboxPhoneNumber

Runtime binding for `sns:VerifySMSSandboxPhoneNumber`.

An account-scoped operation — verifies a sandbox destination phone
number with the one-time password SNS texted to it.
Provide the `VerifySMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
### SMS Sandbox
**Example:** Verify a Sandbox Number
```typescript
const verifySandboxNumber = yield* SNS.VerifySMSSandboxPhoneNumber();
yield* verifySandboxNumber({
  PhoneNumber: "+15555550123",
  OneTimePassword: "123456",
});
```

@binding
