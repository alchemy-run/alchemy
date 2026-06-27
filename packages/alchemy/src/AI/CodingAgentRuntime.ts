import * as Context from "effect/Context";
import type {
  CodingAgentService,
  CodingAgentSessionControl,
} from "./CodingAgent.ts";

/**
 * A `CodingAgentRuntime` is the **concrete coding-agent implementation** — the
 * thing a harness adapter (OpenCode, Claude Code, Codex, …) or a native runtime
 * actually provides inside the Container it runs in. It exposes the full
 * {@link CodingAgentService} interface (send / interrupt / events / poll /
 * readFile / listFiles), identical to {@link CodingAgent} and
 * `CodingAgentContainer` — the three tags differ only in *where* they sit, not
 * in *what* they expose.
 *
 * The reference implementation wraps a per-prompt streaming primitive with the
 * persistent actor built by `makeCodingAgentService` (mailbox, event pub/sub,
 * interrupt, buffered history). A harness package (e.g.
 * `@alchemy.run/harness-opencode`) supplies this `Layer`, which a
 * `CodingAgentContainer` then exposes over RPC.
 */
export class CodingAgentRuntime extends Context.Service<
  CodingAgentRuntime,
  CodingAgentService & CodingAgentSessionControl
>()("@alchemy.run/AI/CodingAgentRuntime") {}
