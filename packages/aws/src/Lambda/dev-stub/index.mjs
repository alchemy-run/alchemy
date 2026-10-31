/**
 * The stub Lambda `alchemy dev` deploys in the real cloud for a Function it
 * emulates, so real event sources can invoke it (see `Lambda/DevBridge.ts`).
 * Each invocation is forwarded to the dev sidecar through an SQS queue; the
 * sidecar runs the emulated Function and writes the result to an S3 object,
 * which this stub waits for and returns as its own.
 *
 * Shipped as-is (`bundle: false`): the Lambda runtime provides the AWS SDK.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});
const s3 = new S3Client({});
const QUEUE_URL = process.env.ALCHEMY_DEV_BRIDGE_QUEUE_URL;
const BUCKET = process.env.ALCHEMY_DEV_BRIDGE_BUCKET;
// SQS accepts up to 1 MiB; larger events travel through the bucket.
const INLINE_LIMIT = 900_000;
// Leave time to report a timeout before Lambda kills the invocation.
const MARGIN_MS = 1_000;

export const handler = async (event, context) => {
  const id = context.awsRequestId;
  const deadline = Date.now() + context.getRemainingTimeInMillis() - MARGIN_MS;
  const payload = JSON.stringify(event);
  const message = { id, deadline };
  if (Buffer.byteLength(payload) > INLINE_LIMIT) {
    message.payloadKey = `requests/${id}.json`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: message.payloadKey, Body: payload }));
  } else {
    message.payload = payload;
  }
  await sqs.send(
    new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) }),
  );

  const Key = `responses/${id}.json`;
  while (Date.now() < deadline) {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key })).then(
      (result) => result.Body.transformToString(),
      (error) => {
        if (error.name === "NoSuchKey") return undefined;
        throw error;
      },
    );
    if (response !== undefined) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
      const result = JSON.parse(response);
      if (result.error !== undefined) {
        const error = new Error(result.error.message);
        error.name = result.error.type ?? "Error";
        throw error;
      }
      return result.payload === undefined ? undefined : JSON.parse(result.payload);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "alchemy dev did not answer in time. Is `alchemy dev` still running for this stack?",
  );
};
