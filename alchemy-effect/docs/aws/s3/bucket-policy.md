# BucketPolicy

**Type:** `AWS.S3.BucketPolicy`

## Props

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| bucket | `Input<BucketName>` | Yes | - | Name of the bucket to attach the policy to. |
| policy | `Input<PolicyDocument>` | Yes | - | The policy document to apply. |

## Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| bucket | `Props["bucket"]` | Name of the bucket the policy is attached to. |
