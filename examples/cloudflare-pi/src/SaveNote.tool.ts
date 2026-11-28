import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Notes } from "./Notes.ts";

/**
 * A tool declared with its implementation, so it has no Layer to provide.
 * The Effect binds what the tool uses: the plan lists the namespace under
 * `save_note`, and the tool can use nothing else.
 */
export class SaveNote extends AI.Tool<SaveNote>()(
  "save_note",
  {
    description:
      "Save a note under a key. Use it whenever the user asks you to remember something.",
    parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
    success: Schema.Void,
  },
  Effect.gen(function* () {
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
    return Effect.fn(function* ({ key, text }) {
      yield* notes.put(key, text).pipe(Effect.orDie);
    });
  }),
) {}
