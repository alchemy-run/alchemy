# aws

AWS provider: 4 services (EC2, Lambda, SQS, DynamoDB) with auto-generated IAM policies.

## STRUCTURE

```
aws/
├── {service}/
│   ├── {resource}.ts              # Resource declaration
│   ├── {resource}.provider.ts     # CRUD + diff logic
│   ├── {resource}.{capability}.ts # Bindings (invoke, send-message, get-item, etc.)
│   ├── client.ts                  # Service client tag
│   └── index.ts                   # Public exports
├── client.ts                      # createAWSServiceClientLayer (retry, logging)
├── credentials.ts (444L)          # Credentials tag + fromEnv/fromProfile
├── config.ts, region.ts, account.ts, arn.ts
└── iam.ts                         # PolicyDocument + PolicyStatement types
```

## SERVICE PATTERNS

**Client tag**:
```typescript
class EC2Client extends Context.Tag("AWS.EC2.Client")<EC2Client, EC2>() {}
export const client = createAWSServiceClientLayer<typeof EC2Client, EC2>(EC2Client, EC2);
```

**Resource attributes** (typed by props):
```typescript
type QueueAttrs<Props> = {
  queueUrl: Props["fifo"] extends true ? `${string}.fifo` : string;
  queueArn: `arn:aws:sqs:${string}:${string}:${Props["queueName"]}`;
};
```

**Provider pattern** (see `queue.provider.ts:10-118`):
- `stables`: Immutable outputs (physicalId, ARN, URL)
- `diff`: Returns `{ action: "replace" }` or `undefined` (allow update)
- `create/update/delete`: Standard CRUD with `yield* session.note(...)`

**Binding pattern** (push-based, attach):
```typescript
SendMessage.provider.succeed({
  attach: ({ source: queue }) => ({
    env: { [toEnvKey(queue.id, "QUEUE_URL")]: queue.attr.queueUrl },
    policyStatements: [{
      Effect: "Allow",
      Action: ["sqs:SendMessage"],
      Resource: [queue.attr.queueArn],
    }],
  }),
});
```

**Event source binding** (pull-based, postattach):
- Uses `postattach` to create Lambda event source mapping
- Example: `queue.event-source.ts:34-109`

**Fine-grained IAM** (see `table.get-item.ts:140-173`):
```typescript
Condition: {
  "ForAllValues:StringEquals": {
    "dynamodb:LeadingKeys": props.leadingKeys?.anyOf,
    "dynamodb:Attributes": props.attributes?.anyOf,
  },
}
```

## WHERE TO LOOK

| Task | File | Key Pattern |
|------|------|-------------|
| Client setup | `ec2/client.ts:9-17` | `Context.Tag` + `createAWSServiceClientLayer` |
| Resource declaration | `sqs/queue.ts:6-22` | Typed attrs from props |
| Provider CRUD | `sqs/queue.provider.ts:10-118` | `stables`, `diff`, `create/update/delete` |
| Push binding (attach) | `sqs/queue.send-message.ts:34-50` | `env` + `policyStatements` |
| Pull binding (postattach) | `sqs/queue.event-source.ts:34-109` | Event source mapping |
| Fine-grained IAM | `dynamodb/table.get-item.ts:140-173` | Condition keys for least privilege |
| Tagging | `lambda/function.provider.ts:221` | `createTagger()`, `createTagsList()` |
| Physical naming | `sqs/queue.provider.ts:23-32` | `createPhysicalName({ id, maxLength })` |
| Retry logic | `client.ts:40-64` | Exponential backoff with jitter |
