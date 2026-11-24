/**
 * A Vault's keys on Google Cloud: stored in Firestore, wrapped under Cloud KMS.
 *
 * @module
 */
export { FirestoreKeyStore, type FirestoreKeyStoreOptions } from "./FirestoreKeyStore.ts";
export { KmsKeyWrap } from "./KmsKeyWrap.ts";
