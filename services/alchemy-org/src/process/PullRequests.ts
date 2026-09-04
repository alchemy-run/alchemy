import * as AI from "alchemy/AI";
import { distilled, floci, nameOf } from "../github/Repos.ts";
import { Distillation } from "./Distillation.ts";
import { AwsEmulation } from "./AwsEmulation.ts";
import { CloudflareEmulation } from "./CloudflareEmulation.ts";

/**
 * THE STANDARD a pull request on alchemy is held to — one document,
 * spliced into both charters: the engineer writes toward it, the
 * reviewer judges against it. Prose only, on purpose: it names no tool
 * (so splicing it charges no capability to either agent) — HOW to
 * check each point is the reviewer's stance, with its own tools. The
 * companion repositories are named by reference (`nameOf`), and the
 * skills for working in them by `.source`: naming, not activating.
 *
 * A nested fragment is one BLOCK of the rendered document: the driver
 * freezes it into the system prompt on the first tick and never
 * re-sends it unless it changes.
 */
export const PullRequests = AI.fragment`
  ## What a pull request on alchemy must be

  1. **Behavior comes with its tests.** A change that adds or alters
     behavior — a resource, a binding, a lifecycle rule, a bug fix —
     lands with the test changes that prove it. A fix without a test
     that failed before it is a claim; a feature without a test that
     exercises it is a draft. Refactors that move code without
     changing behavior are the one exception, and the diff must
     visibly be one.

  2. **Tests are end-to-end fixtures, never mocks.** A test deploys the
     real thing (\`test.provider\` / a Stack against the real cloud, a
     Worker or Lambda fixture driven over HTTP) and asserts against
     what actually happened — never a stubbed client or an
     "expected-call" recorder. Each test covers its VARIANTS (create,
     update, replacement, the adopt path, the failure it handles) and
     is IDEMPOTENT: deterministic names (the engine's auto-naming or a
     constant — never \`Date.now()\`), begins and ends with
     \`stack.destroy()\`, verifies out-of-band through the SDK, and
     leaves nothing behind. A green test that leaks a resource is a
     provider bug by definition.

  3. **The description is written for the developer who will USE it.**
     Title in conventional-commit form. The body leads with what
     changed for the user — the new shape, in a short code snippet
     where one fits — then the why the snippet cannot show. It ends
     with a VERIFICATION REPORT: the exact test command(s) run, what
     passed, what was skipped and the exact reason (an entitlement, a
     platform limit), and any manual step a reviewer must repeat. No
     checklists of promised future testing; no marketing copy.

  4. **A new provider is two pull requests.** Alchemy's providers call
     the generated SDK in ${nameOf(distilled)} (a submodule pinned by
     commit at \`distilled/\`). A pull request that adds or extends a
     provider — new resources, new operations, a typed error — ships a
     COMPANION pull request there (JSON patches under
     \`patches/{service}/\`, the regenerated service), opened from a
     branch of the same name. The alchemy pull request's submodule pin
     must point at that companion: its merge commit once it merged,
     its head commit until then. A pin at some unrelated commit, or a
     companion the alchemy side never mentions, is a problem to name.
     How that work is done is ${Distillation.source}.

  5. **A resource works under \`alchemy dev\` the day it lands.** For
     AWS that is an emulation in ${nameOf(floci)}, the emulator
     \`alchemy dev\` runs AWS providers against: a new AWS resource is
     expected to arrive with a companion pull request there (same
     branch name); where the emulation is deferred, the description
     says so and why — not a blocker on its own, a note in the review
     when absent. How that work is done is ${AwsEmulation.source}. For
     Cloudflare it is a local provider over the in-tree workerd runtime
     (\`packages/cloudflare-runtime\`), registered with
     \`ProviderLayer.dual\` and proven by a \`{Resource}.local.test.ts\`
     beside the live test; a Cloudflare resource without one is not
     done locally. How that work is done is ${CloudflareEmulation.source}.
`;
