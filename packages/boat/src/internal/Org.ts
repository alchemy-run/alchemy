import { Credentials } from "@distilled.cloud/boat-dev/Credentials";
import * as Effect from "effect/Effect";

/**
 * The stack's org (`Boat.providers({ org })`, or the profile's), or
 * `undefined` for none, and for `personal`: both mean what is yours.
 * `/environments` routes ignore `X-Boat-Org`, so the org the protocol sends
 * on every other call is passed there as the `org` query.
 */
export const stackOrg = Effect.gen(function* () {
  const { org } = yield* yield* Credentials;
  const named = org?.trim();
  return named && named.toLowerCase() !== "personal" ? named : undefined;
});

/** The same organization, however it was spelled (Boat ignores case). */
export const sameOrg = (a: string | undefined, b: string | undefined) =>
  (a?.toLowerCase() ?? "personal") === (b?.toLowerCase() ?? "personal");

/** The `org` query parameter, when there is an org. */
export const inOrg = (org: string | undefined) => (org ? { org } : {});

/** Whether an account (a person or an organization) is the one `org` names. */
export const isOrgAccount = (
  account: { id: string; kind: "personal" | "org" | (string & {}); name: string },
  org: string | undefined,
) =>
  org === undefined
    ? account.kind === "personal"
    : account.kind === "org" &&
      (account.id === org || account.name.toLowerCase() === org.toLowerCase());
