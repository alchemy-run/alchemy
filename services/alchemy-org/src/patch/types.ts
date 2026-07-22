export interface AddFile {
  readonly _tag: "AddFile";
  readonly path: string;
  readonly content: string;
}

export interface DeleteFile {
  readonly _tag: "DeleteFile";
  readonly path: string;
}

export interface Hunk {
  readonly header: string | undefined;
  readonly lines: ReadonlyArray<HunkLine>;
  readonly endOfFile: boolean;
  readonly patchLine: number;
}

export interface HunkLine {
  readonly kind: "context" | "add" | "delete";
  readonly text: string;
}

export interface UpdateFile {
  readonly _tag: "UpdateFile";
  readonly path: string;
  readonly moveTo: string | undefined;
  readonly hunks: ReadonlyArray<Hunk>;
}

export type PatchOperation = AddFile | DeleteFile | UpdateFile;

export interface ParsedPatch {
  readonly operations: ReadonlyArray<PatchOperation>;
}

export interface ApplyPatchInput {
  readonly patchText: string;
  readonly expectedDigests: Readonly<Record<string, string>>;
}
