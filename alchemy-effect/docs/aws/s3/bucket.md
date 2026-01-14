# Bucket

**Type:** `AWS.S3.Bucket`

## Props

| Property          | Type                            | Required | Default | Description                                                                                                     |
| ----------------- | ------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| bucketName        | `string`                        | No       | -       | Name of the bucket. If omitted, a unique name will be generated. Must be lowercase and between 3-63 characters. |
| objectLockEnabled | `boolean`                       | No       | -       | Indicates whether this bucket has Object Lock enabled. Once enabled, cannot be disabled.                        |
| forceDestroy      | `boolean`                       | No       | false   | Whether to delete all objects when the bucket is destroyed.                                                     |
| tags              | `Record<string, Input<string>>` | No       | -       | Tags to apply to the bucket.                                                                                    |

## Attributes

| Attribute                | Type                                                                | Description                                                     |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| bucketName               | `Props["bucketName"] extends string ? Props["bucketName"] : string` | Name of the bucket.                                             |
| bucketArn                | `arn:aws:s3:::${this["bucketName"]}`                                | ARN of the bucket.                                              |
| bucketDomainName         | `${this["bucketName"]}.s3.amazonaws.com`                            | Domain name of the bucket (e.g., bucket-name.s3.amazonaws.com). |
| bucketRegionalDomainName | `${this["bucketName"]}.s3.${RegionID}.amazonaws.com`                | Regional domain name of the bucket.                             |
| region                   | `RegionID`                                                          | AWS region where the bucket is located.                         |
| accountId                | `AccountID`                                                         | AWS account ID that owns the bucket.                            |

## Capabilities

### GetObject

**Type:** `AWS.S3.GetObject`

#### Options

| Option            | Type     | Required | Description |
| ----------------- | -------- | -------- | ----------- |
| key               | `string` | Yes      | -           |
| versionId         | `string` | No       | -           |
| range             | `string` | No       | -           |
| ifMatch           | `string` | No       | -           |
| ifNoneMatch       | `string` | No       | -           |
| ifModifiedSince   | `Date`   | No       | -           |
| ifUnmodifiedSince | `Date`   | No       | -           |

#### Functions

- `getObject(...)`

### PutObject

**Type:** `AWS.S3.PutObject`

#### Options

| Option               | Type                                                                                                                                                                         | Required | Description |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| key                  | `string`                                                                                                                                                                     | Yes      | -           |
| body                 | `string \| Buffer \| Uint8Array`                                                                                                                                             | Yes      | -           |
| contentType          | `string`                                                                                                                                                                     | No       | -           |
| contentEncoding      | `string`                                                                                                                                                                     | No       | -           |
| contentDisposition   | `string`                                                                                                                                                                     | No       | -           |
| cacheControl         | `string`                                                                                                                                                                     | No       | -           |
| metadata             | `Record<string, string>`                                                                                                                                                     | No       | -           |
| storageClass         | `\| "STANDARD"     \| "REDUCED_REDUNDANCY"     \| "STANDARD_IA"     \| "ONEZONE_IA"     \| "INTELLIGENT_TIERING"     \| "GLACIER"     \| "DEEP_ARCHIVE"     \| "GLACIER_IR"` | No       | -           |
| serverSideEncryption | `"AES256" \| "aws:kms" \| "aws:kms:dsse"`                                                                                                                                    | No       | -           |
| sseKmsKeyId          | `string`                                                                                                                                                                     | No       | -           |
| tagging              | `string`                                                                                                                                                                     | No       | -           |

#### Functions

- `putObject(...)`

### DeleteObject

**Type:** `AWS.S3.DeleteObject`

#### Options

| Option    | Type     | Required | Description |
| --------- | -------- | -------- | ----------- |
| key       | `string` | Yes      | -           |
| versionId | `string` | No       | -           |

#### Functions

- `deleteObject(...)`

## Event Sources

### BucketEventSource

#### Props

| Property     | Type            | Required | Default                  | Description                                                   |
| ------------ | --------------- | -------- | ------------------------ | ------------------------------------------------------------- |
| events       | `S3EventType[]` | No       | - ["s3:ObjectCreated:*"] | S3 event types to trigger the Lambda function.                |
| filterPrefix | `string`        | No       | -                        | Only trigger for objects with keys starting with this prefix. |
| filterSuffix | `string`        | No       | -                        | Only trigger for objects with keys ending with this suffix.   |

#### Attributes

| Attribute      | Type     | Description                                    |
| -------------- | -------- | ---------------------------------------------- |
| notificationId | `string` | Unique ID for this notification configuration. |
