/**
 * What the harness puts in a session's sandbox: OpenCode itself, and two
 * scripts that run on the Bun inside OpenCode's own binary
 * (`BUN_BE_BUN=1`), so the sandbox needs nothing else installed.
 *
 * @internal
 */

/** The OpenCode release sessions run. */
export const OPENCODE = {
  version: "1.18.18",
  /** sha512 of each platform's npm tarball. */
  sha512: {
    x64: "5a67949e1963609db9db0cb0293896e1b343cec6acda78e98cf5048748cce8728d238bc5c49b5112dcda595898e0028401c3a42d64fc2e5d7b8b1bdc1f3dc09c",
    arm64:
      "7bc0f7834a89108cdac04836fb2816def9198c060bdacb32031e066e2863c17c1916f959672e734565b3773e4a2c1a07493974141ef7bcdb6735e5ce3721e955",
    "x64-musl":
      "956896c68b6ac954c9622bb674df742833434abc26ca1664f1a8f3c9f0058f09acd93055c782f42f2ea091d873f27c6cc703d1bfbe755bcfb2529cdeb41f0030",
    "arm64-musl":
      "0e9dd70721514599e03c0428b4d6cec2bdb61e065e8f8afd0a4d08bfface554fa83b97cb0fd612a47130c7cd054d939998599dfefae209dad1fdd19dcda6c80b",
  },
};

/** Where the bridge and OpenCode listen, on the sandbox's loopback only. */
export const PORTS = { bridge: 41991, opencode: 41992 };

/** The harness's directory in the sandbox user's home. */
export const DIR = `"$HOME/.alchemy/opencode"`;

/** Install OpenCode once per sandbox: the npm tarball, checked against its hash. */
export const INSTALL = `set -e
dir=${DIR}
bin="$dir/opencode-${OPENCODE.version}"
mkdir -p "$dir"
if [ ! -x "$bin" ]; then
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "opencode: unsupported $(uname -m)" >&2; exit 1 ;; esac
  if [ -e /etc/alpine-release ]; then arch="$arch-musl"; fi
  case "$arch" in
    x64) sum=${OPENCODE.sha512.x64} ;;
    arm64) sum=${OPENCODE.sha512.arm64} ;;
    x64-musl) sum=${OPENCODE.sha512["x64-musl"]} ;;
    arm64-musl) sum=${OPENCODE.sha512["arm64-musl"]} ;;
  esac
  url="https://registry.npmjs.org/opencode-linux-$arch/-/opencode-linux-$arch-${OPENCODE.version}.tgz"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$dir/opencode.tgz"; else wget -qO "$dir/opencode.tgz" "$url"; fi
  echo "$sum  $dir/opencode.tgz" | sha512sum -c - >/dev/null
  tar -xzf "$dir/opencode.tgz" -C "$dir" package/bin/opencode
  chmod +x "$dir/package/bin/opencode"
  mv "$dir/package/bin/opencode" "$bin"
  rm -rf "$dir/package" "$dir/opencode.tgz"
fi
ln -sf "$bin" "$dir/opencode"`;

/** Write files under the user's home: pairs of a home-relative path and its base64. */
export const PUT = `while [ $# -gt 0 ]; do
  mkdir -p "$(dirname "$HOME/$1")"
  printf %s "$2" | base64 -d >"$HOME/$1"
  shift 2
done`;

/** Stop the bridge and OpenCode a previous launch left, then run the bridge. */
export const LAUNCH = `cd ${DIR}
for f in bridge.pid opencode.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
done
sleep 0.3
BUN_BE_BUN=1 exec ./opencode bridge.js bridge.json >bridge.log 2>&1`;

/** Run `call.js` with the arguments given. */
export const CALL = `cd ${DIR} && BUN_BE_BUN=1 exec ./opencode call.js "$@"`;

/** Print the session's saved state, or nothing. */
export const READ_STATE = `cat ${DIR}/session.json 2>/dev/null || true`;

/**
 * The bridge. OpenCode asks it for model answers (an OpenAI-compatible
 * endpoint) and tool calls (MCP over HTTP); it holds each request until the
 * harness, which follows `/_requests`, answers it on `/_reply`. A request
 * nobody has answered is given again to whoever follows next, so a host
 * that was evicted picks up where it stopped. It also runs each prompt, so
 * a prompt outlives the call that started it.
 */
export const BRIDGE = String.raw`
const config = JSON.parse(await Bun.file(process.argv[2]).text());
const OPENCODE = "http://127.0.0.1:" + config.opencodePort;
const pending = new Map();
const listeners = new Set();
const prompts = new Map();
let next = 0;

const post = (request, resolve) => {
  const entry = { id: config.epoch + "-" + ++next, request, resolve, chunks: [] };
  pending.set(entry.id, entry);
  for (const listener of listeners) listener(entry);
};
const ask = (request) => new Promise((resolve) => post(request, resolve));

const frame = (entry) => {
  const text = Buffer.from(JSON.stringify({ id: entry.id, ...entry.request })).toString("base64");
  let out = "";
  for (let i = 0; i < text.length; i += 8192) out += "oc:" + text.slice(i, i + 8192) + "\n";
  return out + "oc.\n";
};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const completion = async (body) => {
  const reply = await ask({ kind: "model", body });
  if (reply.error) return json({ error: { message: reply.error, type: "server_error" } }, 500);
  const id = "chatcmpl-" + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const calls = (reply.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
  const usage = {
    prompt_tokens: reply.usage?.input ?? 0,
    completion_tokens: reply.usage?.output ?? 0,
    total_tokens: (reply.usage?.input ?? 0) + (reply.usage?.output ?? 0),
  };
  if (!body.stream) {
    return json({
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply.content ?? "",
            ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
            ...(calls.length > 0 ? { tool_calls: calls.map(({ index, ...call }) => call) } : {}),
          },
          finish_reason: reply.finishReason,
        },
      ],
      usage,
    });
  }
  const chunk = (choices, extra = {}) =>
    "data: " +
    JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices, ...extra }) +
    "\n\n";
  const delta = (value, finish = null) => chunk([{ index: 0, delta: value, finish_reason: finish }]);
  let out = delta({ role: "assistant", content: "" });
  if (reply.reasoning) out += delta({ reasoning_content: reply.reasoning });
  if (reply.content) out += delta({ content: reply.content });
  if (calls.length > 0) out += delta({ tool_calls: calls });
  out += delta({}, reply.finishReason) + chunk([], { usage }) + "data: [DONE]\n\n";
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
};

const rpc = async (server, message) => {
  const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      return result({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: server, version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: config.servers[server] ?? [] });
    case "tools/call": {
      const reply = await ask({
        kind: "tool",
        server,
        name: message.params.name,
        arguments: message.params.arguments ?? {},
      });
      return result({
        content: [{ type: "text", text: reply.text ?? "" }],
        ...(reply.structured !== undefined && reply.structured !== null && typeof reply.structured === "object"
          ? { structuredContent: reply.structured }
          : {}),
        isError: reply.isError === true,
      });
    }
    default:
      return message.id === undefined
        ? undefined
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
};

const handle = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/_health") return json({ epoch: config.epoch });
  if (url.pathname === "/_requests") {
    // One follower at a time: a host that comes back replaces the one it left behind.
    for (const listener of listeners) listener.close();
    listeners.clear();
    let listener;
    return new Response(
      new ReadableStream({
        start(controller) {
          listener = (entry) => controller.enqueue(frame(entry));
          listener.close = () => controller.close();
          controller.enqueue("oc-ready\n");
          for (const entry of pending.values()) listener(entry);
          listeners.add(listener);
        },
        cancel() {
          listeners.delete(listener);
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  }
  if (url.pathname.startsWith("/_reply/")) {
    const entry = pending.get(url.pathname.slice("/_reply/".length));
    if (entry === undefined) return json({ ok: false }, 404);
    entry.chunks.push(Buffer.from(await request.arrayBuffer()));
    if (url.searchParams.get("more") !== "1") {
      pending.delete(entry.id);
      entry.resolve(JSON.parse(Buffer.concat(entry.chunks).toString()));
    }
    return json({ ok: true });
  }
  if (url.pathname === "/_prompt") {
    const { requestId, sessionId, body } = await request.json();
    const known = prompts.get(requestId);
    if (known !== undefined) {
      return json({ ok: true, ...(known.finished ? { finished: known.finished } : {}) });
    }
    const prompt = {};
    prompts.set(requestId, prompt);
    // The answers of the newest prompts are kept, for a caller that asks again.
    if (prompts.size > 200) prompts.delete(prompts.keys().next().value);
    fetch(OPENCODE + "/session/" + sessionId + "/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeout: false,
    })
      .then(
        async (response) => ({ status: response.status, body: await response.text() }),
        (error) => ({ status: 0, body: String(error) }),
      )
      .then((finished) => {
        prompt.finished = finished;
        post({ kind: "done", requestId, ...finished }, () => {});
      });
    return json({ ok: true });
  }
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    return completion(await request.json());
  }
  if (url.pathname.startsWith("/mcp/")) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const server = url.pathname.slice("/mcp/".length);
    const body = await request.json();
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((message) => rpc(server, message)))).filter(
        (reply) => reply !== undefined,
      );
      return replies.length === 0 ? new Response(null, { status: 202 }) : json(replies);
    }
    const reply = await rpc(server, body);
    return reply === undefined ? new Response(null, { status: 202 }) : json(reply);
  }
  return json({ error: "not found" }, 404);
};

await Bun.write("bridge.pid", String(process.pid));
for (let attempt = 0; ; attempt++) {
  try {
    Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 0, fetch: handle });
    break;
  } catch (error) {
    if (attempt === 40) throw error;
    await Bun.sleep(250);
  }
}

const child = Bun.spawn(
  [process.execPath, "serve", "--hostname", "127.0.0.1", "--port", String(config.opencodePort)],
  {
    cwd: config.cwd ?? process.env.HOME,
    env: {
      ...process.env,
      BUN_BE_BUN: undefined,
      OPENCODE_CONFIG: process.cwd() + "/opencode.json",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
await Bun.write("opencode.pid", String(child.pid));
process.on("SIGTERM", () => {
  child.kill();
  process.exit(0);
});
process.exit(await child.exited);
`;

/**
 * The harness's side of every call into the sandbox, one short command
 * each: a request to OpenCode or to the bridge, or the bridge's requests
 * followed as they come. A result is printed as one `oc:` line of base64.
 */
export const CLIENT = String.raw`
const [mode, ...args] = process.argv.slice(2);
const BRIDGE = "http://127.0.0.1:${PORTS.bridge}";
const OPENCODE = "http://127.0.0.1:${PORTS.opencode}";
const out = (value) => console.log("oc:" + Buffer.from(JSON.stringify(value)).toString("base64"));
const bodyOf = async (arg) => {
  if (arg === undefined) return undefined;
  if (!arg.startsWith("@")) return Buffer.from(arg, "base64");
  const file = Bun.file(arg.slice(1));
  const bytes = await file.bytes();
  await file.delete();
  return bytes;
};
if (mode === "follow") {
  const response = await fetch(BRIDGE + "/_requests", { timeout: false });
  for await (const chunk of response.body) process.stdout.write(chunk);
} else if (mode === "wait") {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      // A server that accepts a connection before it can answer would hold
      // the request, and this command, for as long as it likes.
      const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
      const health = await (await get(BRIDGE + "/_health")).json();
      if (health.epoch === args[0] && (await get(OPENCODE + "/global/health")).ok) {
        out({ status: 200, body: "ready" });
        process.exit(0);
      }
    } catch {}
    await Bun.sleep(250);
  }
  out({ status: 0, body: "OpenCode did not start" });
} else {
  try {
    const body = await bodyOf(args[2]);
    const response = await fetch((mode === "bridge" ? BRIDGE : OPENCODE) + args[1], {
      method: args[0],
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body,
      timeout: false,
    });
    out({ status: response.status, body: await response.text() });
  } catch (error) {
    out({ status: 0, body: String(error) });
  }
}
`;
