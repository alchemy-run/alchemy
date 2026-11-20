<!-- Docs for the generated AWS.MQ bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeBroker

Runtime binding for the `DescribeBroker` operation (IAM action
`mq:DescribeBroker`), scoped to one {@link Broker}.

Resolves the broker's live state at runtime — engine version, instance
endpoints (the wire-protocol URIs clients connect to), pending changes,
and maintenance information. Provide the implementation with
`Effect.provide(AWS.MQ.DescribeBrokerHttp)`.
### Observing a Broker
**Example:** Resolve the Broker's Endpoints
```typescript
const describeBroker = yield* MQ.DescribeBroker(broker);

const info = yield* describeBroker();
// info.BrokerState → "RUNNING"
// info.BrokerInstances?.[0]?.Endpoints → ["ssl://b-….mq.us-west-2.amazonaws.com:61617", …]
```

@binding

## ListBrokers

Runtime binding for the `ListBrokers` operation (IAM action
`mq:ListBrokers` on `*` — the operation is not resource-scoped).

Lists all Amazon MQ brokers in the account/region. Provide the
implementation with `Effect.provide(AWS.MQ.ListBrokersHttp)`.
### Observing a Broker
**Example:** List All Brokers
```typescript
const listBrokers = yield* MQ.ListBrokers();

const page = yield* listBrokers();
// page.BrokerSummaries → [{ BrokerName: "orders", BrokerState: "RUNNING", … }]
```

@binding

## RebootBroker

Runtime binding for the `RebootBroker` operation (IAM action
`mq:RebootBroker`), scoped to one {@link Broker}.

Reboots the broker to apply pending modifications (engine version,
host instance type, configuration revision, user changes). The reboot is
asynchronous — the broker transitions through `REBOOT_IN_PROGRESS` back to
`RUNNING`. Provide the implementation with
`Effect.provide(AWS.MQ.RebootBrokerHttp)`.
### Managing a Broker
**Example:** Apply Pending Changes with a Reboot
```typescript
const rebootBroker = yield* MQ.RebootBroker(broker);

yield* rebootBroker();
```

@binding
