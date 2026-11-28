import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Story } from "@effect/ui/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NotYours } from "../src/NotYours.rejection.ts";
import { UserId } from "../src/User.id.ts";
import { NotebookNoDeps, NotesAppNoDeps, NotesMessage, NotesUI, SignIn } from "../src/web/Notes.ts";

const sam = { userId: UserId.make("u-sam"), name: "Sam" };
const notes = (...notes: Array<string>) => ({
  state: Option.some({ notes }),
  cursor: notes.length,
});
const note = HtmlLocator.role("textbox", { name: "Note" });
const listed = HtmlLocator.role("list", { name: "Notes" });

describe("NotesApp", () => {
  it.effect("signing in sends the browser to the chosen provider", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(NotesAppNoDeps, { user: null });
      s.send(NotesMessage.ClickedSignIn({ provider: "github" })).expectExact(SignIn);
      expect(s.pending[0]!.command.args).toEqual({ provider: "github" });
      s.resolve(SignIn, NotesMessage.Failed({ reason: "Provider not found" }));
      expect(s.model.error).toBe("Provider not found");
    }),
  );
});

describe("Notebook", () => {
  it.effect("writes a note to the user's notebook, and shows it from the View", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(NotebookNoDeps, { user: sam });
      s.loaded("notes", notes())
        .type(note, "buy milk")
        .click(HtmlLocator.role("button", { name: "Save" }))
        .expectExact(NotesUI.WriteNote)
        .expect(note)
        .toHaveValue("");
      expect(s.pending[0]!.command.args).toMatchObject({
        input: { userId: sam.userId, text: "buy milk" },
      });
      // The note arrives through the View, not the command's answer.
      s.resolve(NotesUI.WriteNote, {
        commandId: "c-1",
        reply: undefined,
        receipt: { stream: "Notebook/u-sam", version: 1 },
        commits: [{ stream: "Notebook/u-sam", version: 1 }],
      })
        .expect(listed)
        .toHaveText("")
        .loaded("notes", notes("buy milk"))
        .expect(listed)
        .toHaveText("buy milk");
    }),
  );

  it.effect("shows why a note was refused", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(NotebookNoDeps, { user: sam });
      s.loaded("notes", notes())
        .type(note, "not mine")
        .click(HtmlLocator.role("button", { name: "Save" }))
        .fail(NotesUI.WriteNote, { _tag: "Rejected", commandId: "c-1", rejection: new NotYours() })
        .expect(HtmlLocator.role("alert"))
        .toHaveText("Rejected");
    }),
  );
});
