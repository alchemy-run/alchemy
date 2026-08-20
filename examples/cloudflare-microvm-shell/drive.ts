// Headless end-to-end driver: open ONE session WebSocket, run two commands over
// it, and assert streamed output + exit codes. Reusing one socket exercises the
// DO's cached VM (both commands hit the same MicroVM — no re-boot per command).
const base = process.env.SHELL_URL ?? "http://localhost:1337";
const wsBase = base.replace(/^http/, "ws");
const sessionId = "drive-" + Math.random().toString(36).slice(2, 8);

const ws = new WebSocket(`${wsBase}/session/${sessionId}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("socket error")));
});

// Send a command and collect output until its `[exit N]` trailer.
const run = (command: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    const onMessage = (e: MessageEvent) => {
      out += typeof e.data === "string" ? e.data : "";
      if (out.includes("[exit ")) {
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
const first = await run(`echo ${marker}`);
if (!first.includes(marker)) throw new Error(`missing marker: ${first}`);
if (!first.includes("[exit 0]")) throw new Error(`missing exit 0: ${first}`);
console.log("PASS command 1:", JSON.stringify(first));

// A second command over the SAME socket → same cached VM. Write a file, then
// read it back to prove state persists in the one VM across commands.
await run("echo persisted-$$ > /tmp/marker.txt");
const third = await run("cat /tmp/marker.txt");
if (!third.includes("persisted-")) {
  throw new Error(`file did not persist across commands: ${third}`);
}
if (!third.includes("[exit 0]")) throw new Error(`missing exit 0: ${third}`);
console.log("PASS command 2+3 (VM reused, state persisted):", JSON.stringify(third));

ws.close();
console.log("ALL PASS");
