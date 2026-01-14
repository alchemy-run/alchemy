# Queue

**Type:** `AWS.SQS.Queue`

## Capabilities

### SendMessage

**Type:** `AWS.SQS.SendMessage`

#### Functions

- `sendMessage(...)`

## Event Sources

### QueueEventSource

#### Props

| Property          | Type                   | Required | Default | Description |
| ----------------- | ---------------------- | -------- | ------- | ----------- |
| batchSize         | `number`               | No       | -       | -           |
| maxBatchingWindow | `number`               | No       | -       | -           |
| scalingConfig     | `Lambda.ScalingConfig` | No       | -       | -           |

#### Attributes

| Attribute | Type     | Description |
| --------- | -------- | ----------- |
| uuid      | `string` | -           |
