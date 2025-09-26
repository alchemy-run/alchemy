/**
 * Utility functions for Coinbase CDP resources
 */

/**
 * Validates that a CDP account name follows the required format.
 * CDP requires names to be alphanumeric with hyphens, between 2 and 36 characters long.
 *
 * @param name - The account name to validate
 * @throws Error if the name contains invalid characters or is not the correct length
 */
export function validateAccountName(name: string): void {
  if (name.length < 2 || name.length > 36) {
    throw new Error(
      `Invalid account name '${name}'. CDP requires names to be between 2 and 36 characters long.`,
    );
  }

  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error(
      `Invalid account name '${name}'. CDP only allows letters, numbers, and hyphens in account names.`,
    );
  }
}
