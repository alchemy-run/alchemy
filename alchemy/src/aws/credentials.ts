import type { Secret } from "../secret.js";

export interface AwsCredentials {
  accessKeyId: Secret;
  secretAccessKey: Secret;
}
