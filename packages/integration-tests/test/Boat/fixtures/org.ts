/**
 * The team organization of the Boat testing account, by name (Boat matches
 * names case-insensitively). Its wallet is the account's active one, while
 * `/environments` without `org` addresses the account's personal
 * environments, so a resource that drops the org lands somewhere else.
 */
export const TEST_ORG = "Alchemy";

/**
 * Your own account, whatever organization the profile works in: signing in
 * to an account with one organization picks it, so a suite that means the
 * personal wallet says so.
 */
export const PERSONAL = "personal";
