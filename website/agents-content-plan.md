# Agents docs — content plan

The plan for the top-level **Agents** tab (after CLI in the tab bar).
This file is the working plan, not published content (it lives outside
`src/content/`). Sources of truth: `designs/ai/spec.md`,
`packages/alchemy/src/AI/*`, `services/alchemy-org` (the worked
example).

## Positioning

Agents are the third leg of alchemy's pitch: Infrastructure as Code →
Infrastructure as Effects → **organizations as code**. The section
teaches the charter model (prose with spliced capabilities, interpreted
by a kernel) with the same lean, code-first voice as the rest of the
docs. Everything documented exists and runs today on the in-memory
kernel; deferred designs (durable kernel, AI.Workflow) get one roadmap
paragraph, never full pages.

## Navigation wiring

- `src/docs-tabs.ts` — `{ label: "Agents", href: "/agents", prefixes: ["/agents"], slot: "primary" }`
  inserted right after CLI.
- `src/docs-icons.ts` — `Agents: l("bot")` tab icon.
- `astro.config.mjs` — top-level sidebar group `Agents` (label must
  match the tab) inserted after the CLI group.

## Section map

```
Agents
├── Overview                    /agents                      (hub: pitch + smallest agent + map)
├── Tutorial  (4 parts)
│   ├── Part 1: Your first agent      /agents/tutorial/part-1   tag → charter → kernel → dispatch
│   ├── Part 2: Tools                 /agents/tutorial/part-2   Parameter, Tool+Layer, inline tool, AI.reply
│   ├── Part 3: Skills                /agents/tutorial/part-3   teaching on a Layer, activation, graph
│   └── Part 4: An org                /agents/tutorial/part-4   two agents, a door, sessions, settle
├── Concepts
│   ├── Agents & charters       /agents/concepts/agents       init → stance; 3 tiers; mention-is-presence
│   ├── Tools & parameters      /agents/concepts/tools        terms, physics per Layer, inline, AI.reply
│   ├── Skills                  /agents/concepts/skills       dormant bundles, teachings, skill graph
│   ├── Delegation              /agents/concepts/delegation   dispatch, spawn, doors, sessions, supervision
│   ├── Runs & threads          /agents/concepts/runs         keys, park/wake/settle, Thread, Tick, remind
│   ├── Workspaces              /agents/concepts/workspaces   checkouts as capability; topology is the key
│   ├── The kernel              /agents/concepts/kernel       interpret contract, KernelMemory, codemode
│   ├── Observability           /agents/concepts/observability KernelObserver → Chats → useChat
│   ├── Roles & missions        /agents/concepts/roles-and-missions  bindings; authority envelope
│   └── Human in the loop       /agents/concepts/human-in-the-loop   tools as gates; supervised mode
├── Guides
│   ├── Testing agents          /agents/guides/testing        ScriptedModel, deterministic scripts
│   ├── Writing prose           /agents/guides/writing-prose  the context-engineering doctrine
│   └── GitHub events           /agents/guides/github-events  router pattern: events → keyed runs
└── Cheatsheet                  /agents/cheatsheet            the loop-facing surface on one page
```

Deliberate choices (open for feedback):

- **Shared checkouts** and **human approval** are covered as concept
  pages (`workspaces`, `human-in-the-loop`) with guide-quality code
  rather than duplicated as separate guides — each is one coherent
  story, and the concept/guide split felt artificial for them.
- Tutorial builds a **support-ticket triage org** (no GitHub account
  needed until part 4 mentions the real org) so parts 1–3 run with
  nothing but an Anthropic key.
- The alchemy-org factory is quoted throughout as the worked example
  and linked from the overview, but the docs do not assume the reader
  has it.
- Deferred features: one “Roadmap” block on the kernel page (durable
  kernel, AI.Workflow) and nothing else.

## Cross-links

- Cloudflare hub (Workers/Durable Objects/Workflows) from the kernel
  page's roadmap and the overview.
- GitHub provider (bindings + event source) from the GitHub-events
  guide and delegation examples.
- Core → Layers (`/infrastructure-as-effects/layers`) wherever
  missions/physics-by-composition appear.
- Testing (`/testing`) from the testing guide.

## Voice & conventions

- Lean, zero-fluff, code-first (repo blog/docs conventions).
- Tutorial follows the Tutorial Documentation Standard: one concept ⇒
  one `##` heading ⇒ one `diff lang="typescript"` snippet ⇒ one
  explanation paragraph. No compound snippets explained by bullets.
- Real code from `services/alchemy-org` quoted where it teaches better
  than an invented example.
- Every capability claim matches `packages/alchemy/src/AI` as of
  today; nothing speculative.
