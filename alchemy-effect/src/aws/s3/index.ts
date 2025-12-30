// Client
export { S3Client, client, clientFromEnv } from "./client.ts";

// Bucket Resource
export {
  Bucket,
  type BucketProps,
  type BucketAttrs,
  type BucketName,
  type BucketArn,
} from "./bucket.ts";
export { bucketProvider } from "./bucket.provider.ts";

// BucketPolicy Resource
export {
  BucketPolicy,
  type BucketPolicyProps,
  type BucketPolicyAttrs,
} from "./bucket-policy.ts";
export { bucketPolicyProvider } from "./bucket-policy.provider.ts";

// Capabilities
export {
  GetObject,
  getObject,
  getObjectFromLambdaFunction,
  type GetObjectOptions,
} from "./bucket.get-object.ts";

export {
  PutObject,
  putObject,
  putObjectFromLambdaFunction,
  type PutObjectOptions,
} from "./bucket.put-object.ts";

export {
  DeleteObject,
  deleteObject,
  deleteObjectFromLambdaFunction,
  type DeleteObjectOptions,
} from "./bucket.delete-object.ts";

// Event Source
export {
  type OnBucketEvent,
  type S3Event,
  type S3Record,
  type S3EventType,
} from "./bucket.on-event.ts";

export {
  BucketEventSource,
  bucketEventSourceProvider,
  type BucketEventSourceProps,
  type BucketEventSourceAttr,
} from "./bucket.event-source.ts";
