/**
 * A Vault's keys on AWS: stored in DynamoDB, wrapped under KMS.
 *
 * @module
 */
export { DynamoKeyStore } from "./DynamoKeyStore.ts";
export { KmsKeyWrap } from "./KmsKeyWrap.ts";
