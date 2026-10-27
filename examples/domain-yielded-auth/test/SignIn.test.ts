import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@effect/vitest";
import { Auth, Hooks, Operations, Schema as AuthSchema, Sessions, WebCrypto } from "@yielded/auth";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AppAuth } from "../src/Auth.ts";
import { makeAuthHttp } from "../src/AuthHttp.ts";
import { NotesModel } from "../src/Notes.model.ts";
import { NotesApi } from "../src/NotesApi.api.ts";
import { SESSION_COOKIE, SessionLive } from "../src/Session.ts";
import { UserId } from "../src/User.id.ts";
import { VerifySession } from "../src/VerifySession.ts";

// yielded's sessions, signed with a test secret. A sign-in method (GitHub, Google)
// completes authentication; here a trusted test method does, so no provider is needed.
const policy: Sessions.SessionPolicy = {
  issuer: "notes",
  audience: "notes",
  generation: 1,
  idleLifetimeMillis: 60_000,
  absoluteLifetimeMillis: 300_000,
  renewalIntervalMillis: 30_000,
  maximumIssuedAbsoluteLifetimeMillis: 300_000,
  maximumTokenBytes: 4096,
  requireImmediateInvalidation: false,
};
const revision = Sessions.SecurityRevision.make("1");
const requirement: Sessions.AuthenticationRequirement = {
  alternatives: [
    {
      factors: ["possession"],
      userVerified: false,
      phishingResistant: false,
      minimumCredentials: 1,
    },
  ],
  maximumAgeMillis: 60_000,
};

const Base = Layer.mergeAll(
  WebCrypto.layerWebCrypto,
  Hooks.LifecycleHooks.empty,
  Auth.AuthConfig.layer({ secret: Redacted.make("a-test-secret-a-test-secret-a-test-secret") }),
);

// Every subject is active at revision 1, with one sign-in credential.
const Authority = Layer.effect(
  Sessions.AuthenticationAuthority,
  Effect.gen(function* () {
    const hooks = yield* Hooks.LifecycleHooks;
    return {
      capture: (subjectId, credentialIds) =>
        Effect.succeed({
          revision: {
            subjectId,
            securityRevision: revision,
            credentials: credentialIds.map((credentialId) => ({ credentialId, revision })),
          },
          requirement,
        }),
      requirements: () => Effect.succeed(requirement),
      approve: (_input, prepare) =>
        Hooks.coordinateCommit((journal) => Effect.succeed(prepare(undefined, journal))).pipe(
          Effect.map((result) => result.value),
          Effect.mapError(() => Sessions.SessionUnavailable.make({})),
          Effect.provideService(Hooks.LifecycleHooks, hooks),
        ),
    } satisfies Sessions.AuthenticationAuthority["Service"];
  }),
).pipe(Layer.provide(Base));

const Strategy = AppAuth.sessions.statelessLayer(policy).pipe(Layer.provide(Base));
const Completion = AppAuth.sessions
  .completionLayer()
  .pipe(Layer.provide(Layer.mergeAll(Strategy, Authority)), Layer.provide(Base));
const SessionsTest = AppAuth.sessions
  .handlersLayer({ maximumAgeMillis: 60_000 })
  .pipe(
    Layer.provideMerge(Layer.mergeAll(Strategy, Authority, Completion)),
    Layer.provideMerge(Base),
  );

// What `auth.verifySession` does, over the same session module.
const VerifySessionTest = Layer.effect(
  VerifySession,
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof SessionsTest>>();
    return (credential) =>
      AppAuth.sessions.operations.Verify.invoke(Operations.guest, {
        credential: Redacted.value(credential),
      }).pipe(
        Effect.catchTag("InvalidOperationInput", () =>
          Effect.fail(Sessions.SessionInvalid.make({})),
        ),
        Effect.provideContext(context),
      );
  }),
).pipe(Layer.provide(SessionsTest));

/** Complete authentication for a user, as a sign-in method does, and return the session cookie. */
const signIn = Effect.fn(function* (subject: string, displayName: string) {
  const issued: Operations.AuthCredentialCommand[] = [];
  const now = yield* DateTime.now;
  const evidence: Sessions.AuthenticationEvidence = {
    flowId: Sessions.AuthenticationFlowId.make(`flow-${subject}`),
    bindingDigest: AuthSchema.TokenDigest.make("binding"),
    revision: {
      subjectId: AuthSchema.SubjectId.make(subject),
      securityRevision: revision,
      credentials: [{ credentialId: "github", revision }],
    },
    proofs: [
      {
        method: "github",
        credentialId: "github",
        factors: ["possession"],
        userVerified: false,
        phishingResistant: false,
        verifiedAt: now,
      },
    ],
  };
  const result = yield* AppAuth.sessions.operations.Complete.invoke(
    { _tag: "System", authority: "test-sign-in" },
    {
      evidence: yield* Schema.encodeEffect(Sessions.AuthenticationEvidence)(evidence),
      requirement,
      claims: { displayName },
    },
  ).pipe(
    Effect.provideService(Operations.AuthCredentialCommandCollector, (commands) =>
      Effect.sync(() => issued.push(...commands)),
    ),
  );
  expect(result._tag).toBe("Authenticated");
  const session = issued.find((command) => command._tag === "Issue" && command.slot === "session");
  if (session?._tag !== "Issue") return yield* Effect.die("no session was issued");
  return `${SESSION_COOKIE}=${Redacted.value(session.credential)}`;
}, Effect.provide(SessionsTest));

const World = SessionLive.pipe(
  Layer.provideMerge(VerifySessionTest),
  Layer.provideMerge(NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory))),
);

describe("sign-in with yielded", () => {
  it("GitHub and Google send users back to /auth/<provider>/callback", () => {
    const client = { clientId: "client", clientSecret: Redacted.make("secret") };
    const http = makeAuthHttp({
      origin: "https://notes.example.com",
      github: client,
      google: client,
    });
    expect(http.oauth.callbackUrl("github")).toBe("https://notes.example.com/auth/github/callback");
    expect(http.oauth.callbackUrl("google")).toBe("https://notes.example.com/auth/google/callback");
  });

  it.live("a signed-in user writes and reads their own notes", () =>
    Effect.gen(function* () {
      const asSam = { headers: { cookie: yield* signIn("u-sam", "Sam") } };
      const notes = yield* NotesApi.clientInProcess;
      yield* notes.WriteNote({ target: UserId.make("u-sam"), text: "buy milk" }, asSam);
      const read = yield* notes.Notes.get(UserId.make("u-sam"), asSam);
      expect(read?.notes).toEqual(["buy milk"]);
    }).pipe(Effect.provide(World), Effect.scoped),
  );

  it.live("without a session, or with a forged one, the Api refuses", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.clientInProcess;
      const sam = UserId.make("u-sam");
      const anonymous = yield* notes.WriteNote({ target: sam, text: "hi" }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthorized");

      const real = yield* signIn("u-sam", "Sam");
      const forged = { headers: { cookie: `${real.slice(0, -4)}AAAA` } };
      const refused = yield* notes.WriteNote({ target: sam, text: "hi" }, forged).pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthorized");
    }).pipe(Effect.provide(World), Effect.scoped),
  );

  it.live("a user can't write in or read someone else's notebook", () =>
    Effect.gen(function* () {
      const asAlex = { headers: { cookie: yield* signIn("u-alex", "Alex") } };
      const notes = yield* NotesApi.clientInProcess;
      const sam = UserId.make("u-sam");
      const write = yield* notes.WriteNote({ target: sam, text: "hi" }, asAlex).pipe(Effect.flip);
      expect(write._tag).toBe("NotYours");
      const read = yield* notes.Notes.get(sam, asAlex).pipe(Effect.flip);
      expect(read._tag).toBe("NotYours");
    }).pipe(Effect.provide(World), Effect.scoped),
  );
});
