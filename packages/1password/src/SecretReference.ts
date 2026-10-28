import * as Schema from "effect/Schema";

/**
 * A 1Password SDK secret reference: `op://vault/item/[section/]field`.
 * Segments accept ASCII letters, digits, spaces, hyphens, underscores and periods.
 * Use IDs for names containing unsupported characters, not URL encoding.
 * The SDK supports the optional query `?attribute=otp` or `?ssh-format=openssh`.
 * Validation is synchronous and offline; it does not check whether a secret exists.
 */
export const SecretReference = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^op:\/\/[A-Za-z0-9_. -]+\/[A-Za-z0-9_. -]+\/(?:[A-Za-z0-9_. -]+\/)?[A-Za-z0-9_. -]+(?:\?(?:attribute=otp|ssh-format=openssh))?$(?![\s\S])/.test(
        value,
      ) &&
      value
        .slice(5)
        .split("?")[0]
        .split("/")
        .every((segment) => segment.trim().length > 0),
    { message: "Expected op://vault/item/[section/]field with supported 1Password SDK syntax" },
  ),
);
