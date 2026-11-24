import * as Schema from "effect/Schema";

/** The Vault or its key store failed: a key could not be read, or a box is not one of this vault's. */
export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  subject: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Vault: ${this.reason} (subject ${this.subject})`;
  }
}
