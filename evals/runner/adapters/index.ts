import type { HarnessAdapter, HarnessName } from "../types.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";

export const adapters: Record<HarnessName, HarnessAdapter> = {
  "claude-code": claudeCode,
  codex,
  opencode,
  pi,
};
