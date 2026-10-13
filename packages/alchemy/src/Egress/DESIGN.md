# Egress outside Cloudflare (design, not built)

On a Cloudflare Container, the Durable Object intercepts the container's
traffic. A sandbox anywhere else (an AWS microVM, ECS, Fly, a process on your
laptop) has no such hook, so it runs a proxy that sends its egress traffic to
the Worker hosting that Durable Object. From there it takes **the same path
interception takes today**: the owning Durable Object runs the egress handler.

```
┌──── microVM ───────────────────────────┐          ┌──── Cloudflare: the Worker hosting Agent ─────────┐
│                                        │          │                                                   │
│ git / gh / claude                      │          │  Worker fetch                                     │
│   │  HTTPS_PROXY=http://127.0.0.1:3128 │          │   └ /__alchemy/egress:                            │
│   ▼                                    │  HTTPS   │       verify grant → session = Agent id 7f3a…     │
│ alchemy bootstrap's proxy ─────────────┼─────────▶│       → Agent DO 7f3a…  __alchemyEgress(key, req) │
│   (started because                     │          │           └ GitHub.Egress handler (rules, token)  │
│    ALCHEMY_EGRESS_GATEWAY is set)      │          │              → api.github.com                     │
└────────────────────────────────────────┘          └───────────────────────────────────────────────────┘
```

The user code is the same as for a Cloudflare Container. Only the Layer in
`alchemy.run.ts` changes. Sections 1–2 are user code; 3–8 are what Alchemy
does underneath.

## 1. User code: the Durable Object (identical on every platform)

```ts
// src/Agent.ts
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const model = yield* Anthropic.Egress(Sandbox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });
    const github = yield* GitHub.Egress(Sandbox, {
      token: GitHub.ProfileToken,
      repositories: [
        {
          repository: "alchemy-run/alchemy",
          contents: "write",
          pullRequests: "write",
          issues: "write",
          push: { branches: ["agent/**"] },
        },
      ],
    });
    const sandbox = yield* Sandbox;

    return Effect.gen(function* () {
      return {
        work: (issue: number) =>
          sandbox.start({
            egress: [model, github.narrow({ repository: "alchemy-run/alchemy", issue })],
          }),
      };
    });
  }),
) {}
```

```ts
// src/Sandbox.ts
import * as AI from "alchemy/AI";

export class Sandbox extends AI.Sandbox<Sandbox>()("Sandbox") {}
```

```ts
// src/Sandbox.runtime.ts
import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export default Sandbox.make(
  { main: import.meta.url, runtime: "node", image: "node:24-bookworm" },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
```

## 2. User code: pick the platform

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SandboxLive from "./src/Sandbox.runtime.ts";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api; // the Worker that hosts Agent
    return { api: api.url.as<string>() };
  }).pipe(
    // Cloudflare: Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" })),
    Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 })),
  ),
);
```

## 3. Deploy time: what `yield* Anthropic.Egress(Sandbox, …)` does

This is the same as today; it doesn't depend on the platform:

```ts
// alchemy internal: Cloudflare/Containers/Egress.ts (exists today)
// 1. The sandbox image gets placeholders and tools:
yield* sandboxImage.bind`Egress(anthropic)`({
  env: { ANTHROPIC_API_KEY: "alchemy-egress", ALCHEMY_EGRESS_CA: "1" },
});
// 2. The real key is bound into the Worker hosting the Durable Object (a secret):
const apiKey = yield* egressSecret(Config.Redacted("ANTHROPIC_API_KEY"), "ALCHEMY_ANTHROPIC_EGRESS_KEY");
```

## 4. Deploy time: what `yield* Sandbox` binds when the Layer is `AWS.MicroVM.Sandbox`

This is the new part. Yielding the sandbox in the Durable Object binds three
things into **the Worker hosting the Durable Object**:

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts (Layer construction, deploy time)
const host = yield* Cloudflare.Worker; // the Worker hosting this Durable Object

// a. The key grants are signed with: generated once per stage, a Worker secret.
const rootKey = yield* Random("EgressRootKey", { bytes: 32 });
yield* host.bind`EgressRootKey`({ env: { ALCHEMY_EGRESS_ROOT_KEY: rootKey.value } });

// b. Where sandboxes send egress traffic: this Worker's own URL.
yield* host.bind`EgressGateway`({
  env: { ALCHEMY_EGRESS_GATEWAY: Output.interpolate`${host.url}/__alchemy/egress` },
});

// c. AWS credentials for starting microVMs (an IAM role the Worker can assume).
const role = yield* AWS.IAM.Role("SandboxLauncher", { /* … */ });
yield* host.bind`SandboxLauncher`({ env: { AWS_ROLE_ARN: role.roleArn } });
```

The sandbox image is built from `Sandbox.make` like a Cloudflare Container
image: the bundled `main` plus Alchemy's bootstrap (section 6). The bootstrap
is always in the image, which is how the proxy gets into every sandbox.

## 5. Run time: what `sandbox.start({ egress })` does on AWS

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts, start() — runs in the Durable Object
start: ({ egress }) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;

    // 1. A grant for exactly these egresses, for this Durable Object, 15 minutes.
    const grant = Grant.encode(
      [
        `session = ${state.id.toString()}`,
        `class = ${durableObjectClassName(state)}`, // "Agent"
        `expires < ${Date.now() + 15 * 60_000}`,
        ...egress.map((e) => `egress ${e.key}`), // "anthropic", "github:alchemy-run/alchemy#issue42"
        `hosts = ${egress.flatMap((e) => e.hosts).join(",")}`,
      ].reduce(Grant.attenuate, Grant.mint(env.ALCHEMY_EGRESS_ROOT_KEY, "v1")),
    );

    // 2. Make each egress answerable in THIS Durable Object, as on Cloudflare.
    for (const e of egress) registerEgress(state.raw, e);

    // 3. Start the microVM. These env vars are how it learns about the proxy.
    yield* microvms.run({
      image: imageRef, // from the deploy: Sandbox.make's bundle + bootstrap
      env: {
        ...imageEnv, // placeholders: ANTHROPIC_API_KEY=alchemy-egress, GH_TOKEN=alchemy-egress
        ALCHEMY_EGRESS_GATEWAY: env.ALCHEMY_EGRESS_GATEWAY,
        ALCHEMY_EGRESS_GRANT: grant,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HTTP_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
      },
    });
  }),
```

## 6. Run time: the microVM's bootstrap starts the proxy

```ts
// alchemy internal: Runtime/Bootstrap/index.ts — the image's entrypoint, before `main`
await trustEgressCa(); // exists today: writes the CA bundle, sets SSL_CERT_FILE etc.
if (process.env.ALCHEMY_EGRESS_GATEWAY) {
  await startEgressProxy({
    listen: 3128,
    gateway: process.env.ALCHEMY_EGRESS_GATEWAY,
    grant: process.env.ALCHEMY_EGRESS_GRANT!,
  });
}
await runMain(); // the program, e.g. ClaudeCodeServer; git/gh/claude inherit HTTPS_PROXY
```

```ts
// alchemy internal: Runtime/Bootstrap/EgressProxy.ts
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as Grant from "../../Egress/Grant.ts";
import { makeLocalCa } from "../../Egress/LocalCa.ts";

export const startEgressProxy = async (options: {
  readonly listen: number;
  readonly gateway: string;
  readonly grant: string;
}) => {
  let grant = options.grant;
  const hosts = () => new Set(Grant.caveat(grant, "hosts").split(","));
  // Trusted by every program through the bundle trustEgressCa writes.
  const ca = await makeLocalCa("/etc/cloudflare/certs/cloudflare-containers-ca.crt");

  // A request for an egress host, decrypted: send it to the gateway with the grant.
  const toGateway = (req: http.IncomingMessage, res: http.ServerResponse, host: string) => {
    const out = http.request(options.gateway, {
      method: "POST",
      headers: {
        ...req.headers,
        authorization: `Macaroon ${grant}`, // replaces the placeholder credential
        "x-alchemy-target": `https://${host}${req.url}`,
        "x-alchemy-method": req.method!,
      },
    });
    out.on("response", (upstream) => {
      res.writeHead(upstream.statusCode!, upstream.headers);
      upstream.pipe(res);
    });
    req.pipe(out);
  };

  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    const [host, port = "443"] = req.url!.split(":");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (hosts().has(host!)) {
      const decrypted = new tls.TLSSocket(socket, { isServer: true, ...ca.leafFor(host!) });
      http.createServer((r, s) => toGateway(r, s, host!)).emit("connection", decrypted);
    } else {
      const upstream = net.connect(Number(port), host);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }
  });
  proxy.listen(options.listen, "127.0.0.1");

  // Every 10 minutes: a fresh grant, unless the session was revoked.
  setInterval(async () => {
    const res = await fetch(`${options.gateway}/refresh`, {
      method: "POST",
      headers: { authorization: `Macaroon ${grant}` },
    });
    if (res.ok) grant = await res.text();
  }, 10 * 60_000);
};
```

## 7. Run time: the Worker routes the request to the Durable Object

This sits next to the routing that exists today for intercepted container
requests (`WorkerBridge.ts` → `routeEgress`):

```ts
// alchemy internal: Cloudflare/Workers/WorkerBridge.ts, before the user's fetch
if (url.pathname === "/__alchemy/egress" || url.pathname === "/__alchemy/egress/refresh") {
  const grant = Grant.decode(request.headers.get("authorization"));
  if (!Grant.verify(env.ALCHEMY_EGRESS_ROOT_KEY, grant)) return new Response("bad grant", { status: 401 });
  if (Number(Grant.caveat(grant, "expires <")) < Date.now()) {
    return new Response("grant expired", { status: 401 });
  }
  const agent = ctx.exports[Grant.caveat(grant, "class")].get(
    ctx.exports[Grant.caveat(grant, "class")].idFromString(Grant.caveat(grant, "session")),
  );
  if (url.pathname.endsWith("/refresh")) return agent.__alchemyEgressRefresh(grant); // refuses if revoked
  const target = new URL(request.headers.get("x-alchemy-target")!);
  const key = Grant.egressFor(grant, target.hostname); // which granted egress covers this host
  if (!key) return new Response(`${target.hostname} is not granted`, { status: 403 });
  return agent.__alchemyEgress(key, toUpstreamRequest(request, target)); // exists today
}
```

From there, it runs exactly as on Cloudflare: `__alchemyEgress` →
`dispatchEgress` → the GitHub handler (rules, narrowing, refusals) → it adds
the token → `api.github.com`.

## 8. Grants

```ts
// alchemy internal: Egress/Grant.ts
import { createHmac } from "node:crypto";

export interface Grant {
  readonly id: string;
  readonly caveats: ReadonlyArray<string>;
  readonly signature: string;
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export const mint = (rootKey: string, id: string): Grant => ({
  id,
  caveats: [],
  signature: hmac(rootKey, id).toString("hex"),
});

/** Narrows a grant; nothing can widen one. */
export const attenuate = (grant: Grant, caveat: string): Grant => ({
  id: grant.id,
  caveats: [...grant.caveats, caveat],
  signature: hmac(Buffer.from(grant.signature, "hex"), caveat).toString("hex"),
});

export const verify = (rootKey: string, grant: Grant): boolean => {
  let signature = hmac(rootKey, grant.id);
  for (const caveat of grant.caveats) signature = hmac(signature, caveat);
  return signature.toString("hex") === grant.signature;
};
```

The grant isn't the credential that matters. It only lets the sandbox ask
**its own** Durable Object to run **its own** egresses, for 15 minutes. The
tokens never leave the Worker, and the rules (`push.branches`, narrowing)
still run in the Durable Object, as on Cloudflare.

## 9. Revocation

```ts
// alchemy internal: DurableObjectBridge.ts
async __alchemyEgressRefresh(grant) {
  if (await this.state.storage.get("alchemy:egress-revoked")) return new Response("revoked", { status: 403 });
  return new Response(Grant.encode(reissue(grant, { expires: Date.now() + 15 * 60_000 })));
}
// settle / stop: state.storage.put("alchemy:egress-revoked", true); dispatchEgress refuses at once
```

Because every request goes through the Durable Object, revoking takes effect
on the next request, not when the grant expires.

## 10. Every environment

```ts
// Cloudflare Container: interception; no proxy, no grant (built)
Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" }));

// AWS microVM: sections 4–9
Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 }));

// ECS / Fly / Kubernetes: the same bootstrap proxy and Worker route; only microvms.run differs
Effect.provide(AWS.ECS.Sandbox(SandboxLive, { cpu: 8, memory: "32 GB" }));
Effect.provide(Fly.Sandbox(SandboxLive, { size: "performance-8x" }));

// A process on your machine under alchemy dev: the same proxy, the gateway is the local Worker
Effect.provide(Local.Sandbox(SandboxLive));
```

## 11. Open questions

1. **Proxy runtime:** the bootstrap already runs on Node or Bun, but X.509 leaf generation needs `@peculiar/x509`.
2. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, since the sandbox has none, but it does skip the egress rules for non-egress hosts. Closing it needs platform firewall rules that only allow the Worker.
3. **Throughput:** every egress request goes through one Durable Object, as on Cloudflare. That's fine per session, since it's one agent's traffic.
