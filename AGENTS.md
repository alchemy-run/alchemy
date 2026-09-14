# alchemy

Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that extends Infrastructure-as-Code (IaC) by combining business logic and infrastructure config into a single, type-safe program expressed as Effects.

It includes a core IaC engine built with Effect. Effect provides the foundation for type-safe, composable, and testable infrastructure programs. It brings errors into the type-system and provides declarative/composable retry logic that ensure proper and reliable handling of failures.

# Task-specific skills

Keep this file as project orientation. Before acting on a specialized task, load the matching skill:

- `.agents/skills/alchemy-core-concepts/SKILL.md` — architecture vocabulary and repository layout.
- `.agents/skills/alchemy-resource-provider/SKILL.md` — resources, capabilities, bindings, reconcilers, and lifecycle tests.
- `.agents/skills/alchemy-typed-errors/SKILL.md` — distilled model patches and typed-error handling.
- `.agents/skills/alchemy-provider-modes/SKILL.md` — live/local provider semantics and `LocalProvider.make`.
- `.agents/skills/alchemy-testing/SKILL.md` — test runner, fixtures, cleanup, timeouts, and build gates.
- `.agents/skills/alchemy-api-docs/SKILL.md` — generated API docs and source JSDoc.
- `.agents/skills/alchemy-resource-factory/SKILL.md` — multi-agent resource-factory waves and convergence.
- `.agents/skills/alchemy-aws-service/SKILL.md` — complete AWS service bring-up.
- `.agents/skills/alchemy-writing/SKILL.md` — tutorials, PR descriptions, and release posts.

Load every skill that applies. The skills contain mandatory project rules, not optional advice.

# Global invariants

- Source code and JSDoc are authoritative; never manually edit generated provider API Markdown.
- Use `pnpm test`, not `bun test`, for `packages/alchemy/test`.
- Run `pnpm exec tsc -b` before committing unless a coordinator owns the single type-check for a multi-agent wave.
- Stage explicit files. Other agents may share the checkout.
