import * as Domain from "@alchemy.run/domain";
import { NotesModel } from "./Notes.model.ts";
import { Notes } from "./Notes.view.ts";
import { WriteNote } from "./WriteNote.command.ts";

/** What the browser reaches. */
export class NotesApi extends Domain.Api("NotesApi", {
  model: NotesModel,
  commands: [WriteNote],
  views: [Notes],
}) {}
