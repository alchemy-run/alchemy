/**
 * Shared vocabulary of the coder: the typed Parameters that tools and
 * the charter interpolate. A Parameter's template is its description;
 * description and schema are one artifact.
 */
import * as AI from "alchemy/AI";
import * as S from "effect/Schema";

export const path = AI.Parameter("path", S.String)`
A workspace-relative path to a file within the repository checkout
(e.g. "src/index.ts"). Never absolute, never escaping the workspace.`;

export const pattern = AI.Parameter("pattern", S.String)`
A regular expression (full regex syntax, e.g. "log.*Error" or
"function\\s+\\w+"). Pass the raw pattern with no surrounding
slashes or quotes; escape literal ".", "(", "[" and friends.`;

export const command = AI.Parameter("command", S.String)`
A shell command run with 'sh -c' at the workspace root. Chain steps
with '&&'; quote paths containing spaces.`;

export const content = AI.Parameter("content", S.String)`
The COMPLETE new contents of the file — never a patch or a fragment,
the whole file as it should be on disk.`;
