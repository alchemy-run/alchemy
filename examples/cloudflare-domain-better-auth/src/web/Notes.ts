import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { NotesApi } from "../NotesApi.api.ts";
import { UserId } from "../User.id.ts";
import { auth, callAuth } from "./auth.ts";

/** The NotesApi as Effect UI Commands and queries: `WriteNote`, and the `Notes` View. */
export const NotesUI = DomainEffectUI.make(NotesApi);

export const User = Schema.Struct({ userId: UserId, name: Schema.String });
export type User = typeof User.Type;

const Provider = Schema.Literals(["github", "google"]);

export const NotesMessage = UiSchema.TaggedEnum({
  ClickedSignIn: { provider: Provider },
  ClickedSignOut: {},
  ChangedDraft: { text: Schema.String },
  SubmittedNote: {},
  SucceededWriteNote: {},
  Redirecting: {},
  Failed: { reason: Schema.String },
});

/**
 * Send the browser to GitHub or Google; better-auth brings it back to `/` signed in.
 * If better-auth can't start the sign-in, the app shows why.
 */
export class SignIn extends Command.Service<SignIn>()("notes/SignIn", {
  args: { provider: Provider },
  success: NotesMessage,
}) {
  static readonly layer = this.toLayer(({ provider }) =>
    callAuth(() => auth.signIn.social({ provider, callbackURL: "/" })).pipe(
      Effect.match({
        onSuccess: () => NotesMessage.Redirecting(),
        onFailure: ({ message }) => NotesMessage.Failed({ reason: message }),
      }),
    ),
  );
}

/** Clear better-auth's session, then start over signed out. A failed sign-out shows why. */
export class SignOut extends Command.Service<SignOut>()("notes/SignOut", {
  success: NotesMessage,
}) {
  static readonly layer = this.toLayer(() =>
    callAuth(() => auth.signOut()).pipe(
      Effect.andThen(Effect.sync(() => location.reload())),
      Effect.match({
        onSuccess: () => NotesMessage.Redirecting(),
        onFailure: ({ message }) => NotesMessage.Failed({ reason: message }),
      }),
    ),
  );
}

/**
 * A signed-in user's notebook. The `Notes` View is a query: it shows the notes and follows
 * them live, and a written note arrives through it.
 */
export const NotebookNoDeps = Html.component({
  name: "Notebook",
  props: Schema.Struct({ user: User }),
  model: Schema.Struct({ draft: Schema.String, error: Schema.NullOr(Schema.String) }),
  message: NotesMessage,
  queries: {
    notes: { query: NotesUI.Notes, args: ({ props }) => ({ key: props.user.userId }) },
  },
}).make({
  init: () => ({ draft: "", error: null }),
  update: {
    ClickedSignIn: ($) => $.model,
    ClickedSignOut: ($) => $.run(SignOut.make({})),
    ChangedDraft: ($, { text }) => $.evolve({ draft: text }),
    SubmittedNote: ($) =>
      $.model.draft.trim() === ""
        ? $.model
        : $.evolve({ draft: "" }).run(
            // The session cookie goes with the call. A refusal keeps its reason.
            NotesUI.WriteNote.make({
              input: { userId: $.props.user.userId, text: $.model.draft },
            }).pipe(
              Command.match({
                onSuccess: () => NotesMessage.SucceededWriteNote(),
                onFailure: (failure) => NotesMessage.Failed({ reason: failure._tag }),
              }),
            ),
          ),
    // The note arrives through the View; success only clears an error.
    SucceededWriteNote: ($) => $.evolve({ error: null }),
    // The browser is leaving the page.
    Redirecting: ($) => $.model,
    Failed: ($, { reason }) => $.evolve({ error: reason }),
  },
  view: (h, model) =>
    h.div(
      h.h1("Notes"),
      h.p(`Signed in as ${h.props.user.name}`),
      h.form.on("submit", NotesMessage.SubmittedNote()).children(
        h.input
          .attrs({ placeholder: "Write a note", "aria-label": "Note" })
          .value(model.draft)
          .on("input", ({ value }) => NotesMessage.ChangedDraft({ text: value })),
        h.button.attr("type", "submit").children("Save"),
      ),
      h.ul.attr("aria-label", "Notes").children(
        ...Option.match(AsyncResult.value(h.queries.notes), {
          onNone: () => [],
          onSome: ({ state }) =>
            Option.match(state, { onNone: () => [], onSome: ({ notes }) => notes }),
        }).map((note) => h.li(note)),
      ),
      h.button.on("click", NotesMessage.ClickedSignOut()).children("Sign out"),
      model.error !== null && h.p.attr("role", "alert").children(model.error),
    ),
});

/** The notebook with its Commands and queries; the entry provides the NotesApi client. */
export const Notebook = NotebookNoDeps.pipe(
  Component.provide(Layer.mergeAll(NotesUI.layer, SignOut.layer)),
);

/** The app: sign-in buttons, or the signed-in user's notebook. */
export const NotesAppNoDeps = Html.component({
  name: "NotesApp",
  props: Schema.Struct({ user: Schema.NullOr(User) }),
  model: Schema.Struct({ error: Schema.NullOr(Schema.String) }),
  message: NotesMessage,
}).make({
  init: () => ({ error: null }),
  update: {
    ClickedSignIn: ($, { provider }) => $.run(SignIn.make({ provider })),
    ClickedSignOut: ($) => $.model,
    ChangedDraft: ($) => $.model,
    SubmittedNote: ($) => $.model,
    SucceededWriteNote: ($) => $.model,
    Redirecting: ($) => $.model,
    Failed: ($, { reason }) => $.evolve({ error: reason }),
  },
  view: (h, model) =>
    h.props.user === null
      ? h.div(
          h.h1("Notes"),
          h.button
            .on("click", NotesMessage.ClickedSignIn({ provider: "github" }))
            .children("Sign in with GitHub"),
          h.button
            .on("click", NotesMessage.ClickedSignIn({ provider: "google" }))
            .children("Sign in with Google"),
          model.error !== null && h.p.attr("role", "alert").children(model.error),
        )
      : Notebook(h, { key: h.props.user.userId, props: { user: h.props.user } }),
});

/** The app with its sign-in Command. */
export const NotesApp = NotesAppNoDeps.pipe(Component.provide(SignIn.layer));
