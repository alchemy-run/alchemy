import type { Secret } from "../secret.ts";

export interface AwsCredentials {
  accessKeyId: Secret;
  secretAccessKey: Secret;
}
