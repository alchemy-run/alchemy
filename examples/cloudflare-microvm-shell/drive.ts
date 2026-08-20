// Headless end-to-end driver: open ONE session WebSocket, run commands over it,
// and assert streamed output. Reusing one socket exercises the DO's cached VM
// (all commands hit the same MicroVM — no re-boot per command).
const base = process.env.SHELL_URL ?? "http://localhost:1337";
const wsBase = base.replace(/^http/, "ws");
const sessionId = "drive-" + Math.random().toString(36).slice(2, 8);

const ws = new WebSocket(`${wsBase}/session/${sessionId}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("socket error")));
});

// Send a command and collect output until `expected` shows up — the shell
// renders like a real terminal now (no exit-status trailer to key on).
const run = (command: string, expected: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    const onMessage = (e: MessageEvent) => {
      out += typeof e.data === "string" ? e.data : "";
      if (out.includes(expected)) {
        ws.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(out);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`timeout for '${command}' (got: ${out})`));
    }, 60_000);
    ws.addEventListener("message", onMessage);
    ws.send(command);
  });

const marker = "hello-from-microvm";
const first = await run(`echo ${marker}`, marker);
if (first.includes("[exit")) throw new Error(`exit chatter leaked: ${first}`);
console.log("PASS command 1:", JSON.stringify(first));

// A second command over the SAME socket → same cached VM. Write a file, then
// read it back to prove state persists in the one VM across commands.
await run("echo persisted-$$ > /tmp/marker.txt && echo written", "written");
const third = await run("cat /tmp/marker.txt", "persisted-");
console.log("PASS command 2+3 (VM reused, state persisted):", JSON.stringify(third));

// Real-shell rendering: output ends with exactly one newline — no padding
// blank lines, no status lines.
if (/\n\n/.test(first + third)) {
  throw new Error(`blank-line padding leaked: ${JSON.stringify({ first, third })}`);
}

ws.close();
console.log("ALL PASS");
