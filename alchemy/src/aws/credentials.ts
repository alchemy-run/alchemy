import type { Secret } from "../secret";

export interface AwsCredentials {
  accessKeyId: Secret;
  secretAccessKey: Secret;
}
