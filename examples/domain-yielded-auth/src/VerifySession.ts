import type { Auth } from "@yielded/auth";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

/** A yielded session, as the Api needs it. */
export interface VerifiedSession {
  readonly subjectId: string;
  readonly claims: { readonly displayName: string };
}

/** Checks a session credential: yielded's `auth.verifySession`. */
export class VerifySession extends Context.Service<
  VerifySession,
  (credential: Redacted.Redacted<string>) => Effect.Effect<VerifiedSession, Auth.SessionApiError>
>()("Notes/VerifySession") {}
