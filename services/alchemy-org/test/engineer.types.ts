/**
 * Type-level audit: `Agent.make(charter)` must union the TURN effect's
 * requirements into the Layer — a capability mentioned in the turn's
 * prose (`${Coding}`, `${OpenPullRequest}`) is a type-level requirement
 * of `EngineerLive`, and an unmentioned one is not. Compiled by
 * `bun tsc -b`; never executed.
 */
import type * as Layer from "effect/Layer";
import type { Kernel } from "alchemy/AI";
import type * as Git from "alchemy/Git";
import type { Coding } from "../src/Coding.ts";
import { EngineerLive } from "../src/Engineer.ts";
import type { MergePullRequest, OpenPullRequest } from "../src/tools/index.ts";

type Req = typeof EngineerLive extends Layer.Layer<any, any, infer R>
  ? R
  : never;

// Coding must be a requirement (mentioned in the turn's prose)
const _coding: Coding extends Req ? true : false = true;
// OpenPullRequest must be a requirement
const _openPr: OpenPullRequest extends Req ? true : false = true;
// Kernel must be a requirement
const _kernel: Kernel extends Req ? true : false = true;
// Git.Workspaces must be a requirement (init resolves it, turn checks out)
const _workspaces: Git.Workspaces extends Req ? true : false = true;
// Req must not be `any`
const _notAny: 0 extends 1 & Req ? false : true = true;
// negative control: an unmentioned capability must NOT be in Req
// (also catches Req = unknown, where everything would extend)
const _negative: MergePullRequest extends Req ? false : true = true;

export { _coding, _kernel, _negative, _notAny, _openPr, _workspaces };
