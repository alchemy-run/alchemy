import * as AI from "alchemy/AI";
import * as S from "effect/Schema";

export const patchText = AI.Parameter("patchText", S.String)`
The complete patch in the apply-patch grammar. It must start with
"*** Begin Patch", end with "*** End Patch", and contain Add File,
Delete File, or Update File operations. Update operations contain one or
more "@@" hunks; prefix unchanged, added, and removed lines with " ",
"+", and "-". Use "*** Move to: relative/path" immediately after an
Update File header to rename it, and "*** End of File" to anchor the
preceding hunk at EOF. Every path must be normalized and relative to the
workspace.`;

export const expectedDigests = AI.Parameter(
  "expectedDigests",
  S.Record(S.String, S.String),
)`
A map from every existing source file read by this patch (each Update
File and Delete File source that already exists on disk) to the SHA-256
digest returned by readFile. Omit newly added files. The apply is
rejected before mutation when a digest is absent or stale.`;
