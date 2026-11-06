import * as Archil from "@alchemy.run/archil";

export const API_PORT = 3001;

/** Every note is a JSON file on this disk. */
export const NotesDisk = Archil.Disk("Notes", {});
