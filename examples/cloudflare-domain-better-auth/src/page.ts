import * as Domain from "@alchemy.run/domain";
import { createAuthClient } from "better-auth/client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { NotesApi } from "./NotesApi.api.ts";
import { UserId } from "./User.id.ts";

const auth = createAuthClient();

// The session cookie is first-party, so every call to /api carries it.
const Connection = Domain.protocolHttp(`${location.origin}/api`).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const withNotes = <A, E>(
  f: (notes: Effect.Success<typeof NotesApi.client>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    NotesApi.client.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(Connection)),
  );

const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const greeting = document.querySelector<HTMLElement>("#greeting")!;
const list = document.querySelector<HTMLUListElement>("#notes")!;
const form = document.querySelector<HTMLFormElement>("#write")!;
const text = document.querySelector<HTMLInputElement>("#text")!;

for (const provider of ["github", "google"] as const) {
  document.querySelector(`#${provider}`)!.addEventListener("click", () => {
    void auth.signIn.social({ provider, callbackURL: "/" });
  });
}

document.querySelector("#sign-out")!.addEventListener("click", async () => {
  await auth.signOut();
  location.reload();
});

const show = async (userId: UserId) => {
  const notes = await withNotes((api) => api.Notes.get(userId));
  list.replaceChildren(
    ...(notes?.notes ?? []).map((note) =>
      Object.assign(document.createElement("li"), { textContent: note }),
    ),
  );
};

const session = await auth.getSession();
if (session.data) {
  const userId = UserId.make(session.data.user.id);
  greeting.textContent = `Signed in as ${session.data.user.name}`;
  signedIn.hidden = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await withNotes((api) => api.WriteNote({ target: userId, text: text.value }));
    text.value = "";
    await show(userId);
  });
  await show(userId);
} else {
  signedOut.hidden = false;
}
