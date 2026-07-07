import type { EvalsConfig } from "./runner/types.ts";

/**
 * The (harness × model) matrix and budgets for eval runs.
 *
 * All four adapters are implemented; only claude-code × claude-fable-5 is
 * enabled for now. Flip `enabled` (or pass --harness/--model) as auth for the
 * other harnesses is verified. See processes/Evals/eval-framework-plan.md.
 */
export default {
  harnesses: [
    {
      name: "claude-code",
      enabled: true,
      models: ["claude-fable-5"],
    },
    {
      name: "codex",
      enabled: false, // blocked: `codex logout && codex login` needed (refresh token expired)
      models: ["gpt-5.2-codex"],
    },
    {
      name: "opencode",
      enabled: false, // adapter untested; direct anthropic/ provider needs a fresh key in opencode auth
      models: ["anthropic/claude-fable-5", "openai/gpt-5.2-codex"],
    },
    {
      name: "pi",
      enabled: false, // adapter untested; reads ANTHROPIC_API_KEY / OPENAI_API_KEY from env (doppler provides)
      models: ["claude-fable-5", "gpt-5.2-codex"],
    },
  ],
  trials: 1,
  budgets: {
    wallClockMs: 30 * 60_000,
    maxTurns: 120,
    budgetUsd: 8,
  },
} satisfies EvalsConfig;
