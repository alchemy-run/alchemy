import * as Domain from "@alchemy.run/domain";
import { Notes } from "./Notes.view.ts";
import { WriteNote } from "./WriteNote.command.ts";

/** What the browser reaches. */
export class NotesApi extends Domain.Api("NotesApi", WriteNote, Notes) {}
