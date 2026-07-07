import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, VerifyContext } from "./types.ts";

/**
 * Product-level verifier for "user"-mode tasks: a headless Claude probes the
 * DEPLOYED app (black box — no source access) against the task's hidden
 * verify/intent.md and reports one pass/fail per intent check, with evidence.
 *
 * Tools are restricted to curl/fetch-style probing; the verifier never sees
 * the agent's workspace, so it can't be gamed by code comments or README
 * claims. Playwright MCP is the planned upgrade for JS-only UIs.
 */
export async function runVerifierAgent(options: {
  taskDir: string;
  context: VerifyContext;
  model?: string;
  timeoutMs?: number;
}): Promise<CheckResult[]> {
  const intent = readFileSync(
    join(options.taskDir, "verify", "intent.md"),
    "utf8",
  );

  const prompt = `You are a rigorous black-box QA verifier. A coding agent claims to have
deployed a working product at this URL:

  ${options.context.url}

Below is the hidden product intent. For EACH check listed under "## Checks",
probe the LIVE deployment (curl the pages/endpoints, submit forms, follow
links, inspect returned HTML/JSON) and decide pass or fail. Be adversarial:
a check passes only if you observed the behavior actually working end-to-end
with your own requests — never because a page claims it works. Use unique
marker strings (include "qa-${crypto.randomUUID().slice(0, 8)}") in any content
you create so you can verify round-trips. If the UI is a JavaScript SPA whose
actions you cannot exercise via HTTP alone, look for the underlying HTTP
endpoints the page's JS calls (read the served JS bundles if needed) and drive
those; if you still cannot exercise a behavior, that check FAILS with detail
"unverifiable over HTTP".

${intent}

When you are done, output ONLY a JSON object as the final line of your
response, no markdown fences, exactly this shape:
{"checks":[{"id":"<check-id>","pass":true|false,"detail":"<1-2 sentence evidence>"}]}
Include every check id from the intent, in order.`;

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format",
      "json",
      "--model",
      options.model ?? "claude-fable-5",
      "--permission-mode",
      "bypassPermissions",
      "--allowed-tools",
      "Bash,WebFetch",
      "--max-turns",
      "40",
    ],
    {
      stdin: Buffer.from(prompt),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(
    () => proc.kill("SIGKILL"),
    options.timeoutMs ?? 15 * 60_000,
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);

  try {
    const envelope = JSON.parse(stdout) as { result?: string };
    const text = envelope.result ?? "";
    // The verdict is the last JSON object line in the verifier's reply.
    const lines = text.trim().split("\n").reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      const parsed = JSON.parse(candidate) as { checks?: CheckResult[] };
      if (Array.isArray(parsed.checks)) {
        return parsed.checks.map((check) => ({
          id: String(check.id),
          pass: check.pass === true,
          detail: check.detail ? String(check.detail).slice(0, 500) : undefined,
        }));
      }
    }
    return [
      { id: "verifier", pass: false, detail: "no JSON verdict in verifier output" },
    ];
  } catch (error) {
    return [
      {
        id: "verifier",
        pass: false,
        detail: `verifier crashed: ${String(error).slice(0, 300)}`,
      },
    ];
  }
}
