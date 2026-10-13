# Egress outside Cloudflare (design, not built)

On a Cloudflare Container, the Durable Object intercepts the container's
traffic. A sandbox anywhere else (an AWS microVM, ECS, Fly, a process on your
laptop) has no such hook, so it runs a proxy:

- **The proxy** (in the sandbox) sends requests for egress hosts to a
  **gateway route on the Worker**. Every other host goes straight out.
- **The gateway** checks the request's **grant**, runs the **egress handler**
  (rules, credentials), and streams the request upstream. It scales with the
  Worker and runs at the edge nearest the sandbox.
- **The session's Durable Object** is only asked about state: refreshing a
  grant, revocation on writes, and pushing a new grant when the egress set
  changes.

```
┌──── microVM ────────────────────────────┐        ┌──── Cloudflare: the Worker hosting Agent ──────────────┐
│ git / gh / claude                       │        │                                                        │
│   │ HTTPS_PROXY=http://127.0.0.1:3128   │        │  /__alchemy/egress            (any edge, stateless)    │
│   ▼                                     │ HTTPS  │    verify grant → the egress handler, narrowed by the  │
│ proxy (bootstrap) ──────────────────────┼───────▶│    grant → add the token → stream to api.github.com    │
│   routes by the grant's `hosts`         │        │    writes: ask the Agent DO "revoked?"                 │
│   other hosts: tunnel straight out      │        │                                                        │
│                                         │        │  /__alchemy/egress/refresh    → Agent DO: still live?  │
│ control port :3129 ◀────────────────────┼────────┤  Agent DO: setEgress → push a new grant to :3129       │
└─────────────────────────────────────────┘        └────────────────────────────────────────────────────────┘
```

Sections 1–3 are user code, the same on every platform except the Layer in
`alchemy.run.ts`. Sections 4–11 are what Alchemy does underneath.

## 1. User code: declare the egresses

```ts
// src/egress.ts
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import { Sandbox } from "./Sandbox.ts";

// Declarations (not yielded here): yielded in the Durable Object and in the gateway.
export const Model = Anthropic.Egress(Sandbox, {
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
});

export const Repo = GitHub.Egress(Sandbox, {
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
```

## 2. User code: the Durable Object and the Worker

```ts
// src/Agent.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Model, Repo } from "./egress.ts";
import { Sandbox } from "./Sandbox.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const model = yield* Model;
    const repo = yield* Repo;
    const sandbox = yield* Sandbox;

    return Effect.gen(function* () {
      return {
        work: (issue: number) =>
          Effect.gen(function* () {
            yield* sandbox.start({
              egress: [model, repo.narrow({ repository: "alchemy-run/alchemy", issue })],
            });
            // Later in the session: the proxy gets a new grant at once (section 9).
            yield* sandbox.setEgress([model]);
          }),
        // Settle / stop: grants are no longer refreshed; writes stop at once.
        settle: () => sandbox.revokeEgress(),
      };
    });
  }),
) {}
```

```ts
// src/worker.ts — the Worker that hosts Agent
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Agent } from "./Agent.ts";
import { Model, Repo } from "./egress.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;
    // Serves /__alchemy/egress and /__alchemy/egress/refresh on this Worker,
    // ahead of `fetch` below. Yielding the egresses binds their secrets here.
    yield* Cloudflare.EgressGateway({ egress: [Model, Repo], control: Agent });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const id = new URL(request.url, "http://x").searchParams.get("issue")!;
        yield* (yield* agents.getByName(`issue-${id}`)).work(Number(id));
        return HttpServerResponse.text("started");
      }),
    };
  }),
) {}
```

```ts
// src/Sandbox.ts
import * as AI from "alchemy/AI";

export class Sandbox extends AI.Sandbox<Sandbox>()("Sandbox") {}
```

```ts
// src/Sandbox.runtime.ts — nothing about the proxy here
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

## 3. User code: pick the platform

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
    const api = yield* Api;
    return { api: api.url.as<string>() };
  }).pipe(
    // Cloudflare: Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" })),
    Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 })),
  ),
);
```

## 4. Deploy time: what each egress binds into the sandbox image

`yield* Repo` (in the Durable Object) binds the parts that must be in the
image: tools, placeholders, and the switch that starts the proxy. This is
what `Egress.ts` does today, plus `ALCHEMY_EGRESS_PROXY`:

```ts
// alchemy internal: Egress/Egress.ts, when a declaration is yielded at deploy time
yield* sandbox.bind`Egress(${key})`({
  image: [gitCliLayer, ghCliLayer], // GitHub.Egress; Anthropic.Egress: none
  env: {
    GH_TOKEN: "alchemy-egress", // a placeholder: tools think they're signed in
    ALCHEMY_EGRESS_PROXY: "1", // the bootstrap starts the proxy (non-Cloudflare sandboxes)
  },
});
// The real credential is bound into the hosting Worker as a secret:
yield* worker.bind`Egress(${key})`({ env: { [`ALCHEMY_EGRESS_SECRET_${key}`]: token } });
```

**The image does not list hosts.** Which hosts go to the gateway depends on
the session (narrowing) and can change mid-session (`setEgress`), so it comes
from the grant at runtime (section 7).

## 5. Deploy time: what the microVM Layer binds into the hosting Worker

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts (Layer construction, deploy time)
const worker = yield* Cloudflare.Worker; // the Worker hosting the Durable Object

// Signs grants. Generated once per stage; a Worker secret.
const rootKey = yield* Random("EgressRootKey", { bytes: 32 });
yield* worker.bind`EgressRootKey`({ env: { ALCHEMY_EGRESS_ROOT_KEY: rootKey.value } });

// Where sandboxes send egress traffic: this Worker's URL.
yield* worker.bind`EgressGateway`({
  env: { ALCHEMY_EGRESS_GATEWAY: Output.interpolate`${worker.url}/__alchemy/egress` },
});

// Starting microVMs.
const launcher = yield* AWS.IAM.Role("SandboxLauncher", {
  /* trust: this Worker; permissions: run/stop microVMs from this image */
});
yield* worker.bind`SandboxLauncher`({ env: { AWS_ROLE_ARN: launcher.roleArn } });
```

## 6. Run time: `sandbox.start({ egress })` on AWS

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — runs in the Durable Object
start: ({ egress }) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;

    // Only this Durable Object can change the sandbox's grant (section 9).
    const controlSecret = crypto.randomUUID();
    yield* state.storage.put("alchemy:egress-control", controlSecret);

    const grant = mintGrant(env.ALCHEMY_EGRESS_ROOT_KEY, {
      session: state.id.toString(),
      class: "Agent",
      egress, // each egress's key + narrowed scope + hosts
    });

    yield* microvms.run({
      image: imageRef, // Sandbox.make's bundle + Alchemy's bootstrap + section 4's layers
      env: {
        ...imageEnv, // GH_TOKEN=alchemy-egress, ALCHEMY_EGRESS_PROXY=1
        ALCHEMY_EGRESS_GATEWAY: env.ALCHEMY_EGRESS_GATEWAY,
        ALCHEMY_EGRESS_GRANT: grant,
        ALCHEMY_EGRESS_CONTROL_SECRET: controlSecret,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HTTP_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
      },
      ports: [3000, 3129], // the harness; the proxy's control port
    });
  }),

// A grant: what this session's sandbox may route to the gateway, for 15 minutes.
const mintGrant = (rootKey: string, session: { session: string; class: string; egress: ReadonlyArray<Egress> }) =>
  Grant.encode(
    [
      `session = ${session.session}`,
      `class = ${session.class}`,
      `expires < ${Date.now() + 15 * 60_000}`,
      ...session.egress.map((e) => `egress ${e.declaration} = ${JSON.stringify(e.scope ?? {})}`),
      // e.g. 'egress Repo = {"repository":"alchemy-run/alchemy","issue":42}'
      `hosts = ${session.egress.flatMap((e) => e.hosts).join(",")}`,
      // e.g. "api.anthropic.com,api.github.com,uploads.github.com,github.com"
    ].reduce(Grant.attenuate, Grant.mint(rootKey, "v1")),
  );
```

## 7. Run time: the sandbox's bootstrap starts the proxy

The proxy routes by **the grant's `hosts`**, not by a list in the image:

```ts
// alchemy internal: Runtime/Bootstrap/index.ts — the image's entrypoint, before `main`
await trustEgressCa(); // exists today: writes the CA bundle, sets SSL_CERT_FILE etc.
if (process.env.ALCHEMY_EGRESS_PROXY) {
  await startEgressProxy({
    gateway: process.env.ALCHEMY_EGRESS_GATEWAY!,
    grant: process.env.ALCHEMY_EGRESS_GRANT!,
    controlSecret: process.env.ALCHEMY_EGRESS_CONTROL_SECRET!,
  });
}
await runMain();
```

```ts
// alchemy internal: Runtime/Bootstrap/EgressProxy.ts
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as Grant from "../../Egress/Grant.ts";
import { makeLocalCa } from "../../Egress/LocalCa.ts";

export const startEgressProxy = async (options: {
  readonly gateway: string;
  readonly grant: string;
  readonly controlSecret: string;
}) => {
  let grant = options.grant;
  // The grant decides routing; it changes when the Durable Object pushes a new one.
  const routed = () => new Set(Grant.caveat(grant, "hosts").split(","));
  // Trusted by every program through the bundle trustEgressCa writes.
  const ca = await makeLocalCa("/etc/cloudflare/certs/cloudflare-containers-ca.crt");

  // A request for a routed host, decrypted: send it to the gateway, streaming both ways.
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
    req.pipe(out); // streamed: a large git push never sits in memory
  };

  // :3128 — what HTTPS_PROXY points at.
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    const [host, port = "443"] = req.url!.split(":");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (routed().has(host!)) {
      const decrypted = new tls.TLSSocket(socket, { isServer: true, ...ca.leafFor(host!) });
      http.createServer((r, s) => toGateway(r, s, host!)).emit("connection", decrypted);
    } else {
      // Not an egress host (npm, PyPI, docs): straight out, never through Cloudflare.
      const upstream = net.connect(Number(port), host);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }
  });
  proxy.listen(3128, "127.0.0.1");

  // :3129 — the control port: only the Durable Object (holding controlSecret) can swap the grant.
  http
    .createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${options.controlSecret}`) {
        return void res.writeHead(401).end();
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      grant = body; // routing follows the new grant on the next request
      res.writeHead(204).end();
    })
    .listen(3129, "0.0.0.0");

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

## 8. Run time: the gateway runs the egress handler in the Worker

`Cloudflare.EgressGateway` (section 2) puts this ahead of the user's `fetch`:

```ts
// alchemy internal: Egress/Gateway.ts
const gateway = (egress: ReadonlyArray<EgressDeclaration>, control: DurableObjectNamespace) =>
  async (request: Request, env: Env): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__alchemy/egress")) return undefined; // the user's fetch

    const grant = Grant.decode(request.headers.get("authorization"));
    if (!Grant.verify(env.ALCHEMY_EGRESS_ROOT_KEY, grant)) return new Response("bad grant", { status: 401 });
    if (Number(Grant.caveat(grant, "expires <")) < Date.now()) {
      return new Response("grant expired", { status: 401 });
    }
    const agent = control.get(control.idFromString(Grant.caveat(grant, "session")));

    if (url.pathname.endsWith("/refresh")) {
      // State lives in the Durable Object: it says whether the session is still live.
      if (await agent.__alchemyEgressRevoked()) return new Response("revoked", { status: 403 });
      return new Response(Grant.encode(Grant.renew(env.ALCHEMY_EGRESS_ROOT_KEY, grant, "15 minutes")));
    }

    const target = new URL(request.headers.get("x-alchemy-target")!);
    // Which granted egress covers this host, and its narrowed scope (from the grant).
    const granted = egress
      .map((e) => ({ e, scope: Grant.egressScope(grant, e.key) }))
      .find(({ e, scope }) => scope !== undefined && e.hosts.includes(target.hostname));
    if (!granted) return new Response(`${target.hostname} is not granted`, { status: 403 });

    // Writes (push, comment, merge) are rare and where damage happens: check revocation.
    if (isWrite(request) && (await agent.__alchemyEgressRevoked())) {
      return new Response("revoked", { status: 403 });
    }

    // The same handler as on Cloudflare, narrowed exactly as the Durable Object narrowed it.
    const handler = granted.e.narrow(granted.scope);
    return handler.handle(toUpstreamRequest(request, target), env); // adds the token; streams the body
  };
```

## 9. Run time: changing the egress set mid-session

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — runs in the Durable Object
setEgress: (egress) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;
    const grant = mintGrant(env.ALCHEMY_EGRESS_ROOT_KEY, { session: state.id.toString(), class: "Agent", egress });
    const controlSecret = yield* state.storage.get<string>("alchemy:egress-control");
    // The proxy's control port, through the platform's URL for the microVM's port 3129.
    yield* HttpClient.post(`${machineUrl(3129)}/`, {
      body: grant,
      headers: { authorization: `Bearer ${controlSecret}` },
    });
  }),
```

The old grant still verifies until it expires. To make removal immediate,
the gateway also checks a `grant generation` caveat against the Durable
Object, on writes only (cheap). See section 10.

## 10. Revocation

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — runs in the Durable Object
revokeEgress: () => state.storage.put("alchemy:egress-revoked", true),

// alchemy internal: DurableObjectBridge.ts
async __alchemyEgressRevoked() {
  return (await this.state.storage.get("alchemy:egress-revoked")) === true;
}
```

- **Writes** stop on the next request (the gateway asks the Durable Object).
- **Reads** stop at the next refresh, within 15 minutes.

## 11. Grants

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

A grant isn't a credential for GitHub or Anthropic. It lets the sandbox ask
the gateway to run **its own session's** egresses, as narrowed, for 15
minutes. The tokens stay in the Worker.

## 12. Cloudflare Containers stay as they are

```ts
Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" }));
```

There's no proxy and no grant here: the Durable Object intercepts the
container's traffic and runs the same handlers (built). The only change for
Cloudflare is streaming request bodies instead of buffering them; today
`makeEgressHandle` reads the whole body.

## 13. Every environment

```ts
// Cloudflare Container: interception (built)
Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" }));

// AWS microVM: sections 4–11
Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 }));

// ECS / Fly / Kubernetes: the same proxy and gateway; only how the sandbox starts differs
Effect.provide(AWS.ECS.Sandbox(SandboxLive, { cpu: 8, memory: "32 GB" }));
Effect.provide(Fly.Sandbox(SandboxLive, { size: "performance-8x" }));

// A process on your machine under alchemy dev: the same proxy; the gateway is the local Worker
Effect.provide(Local.Sandbox(SandboxLive));
```

## 14. Open questions

1. **Certificates:** the proxy generates X.509 leaf certificates, which Node can't do natively. Use `@peculiar/x509`, or write the proxy in Go?
2. **The control port** needs the platform to expose port 3129 to the Durable Object only (a security group or private networking). Over the public internet, the control secret is the only protection.
3. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, since the sandbox has none, but it does skip the rules for non-egress hosts. Closing it needs a firewall that only allows the Worker.
4. **Grant generation:** making removal via `setEgress` immediate for reads too would mean the gateway asks the Durable Object on every request, losing the stateless path. Writes-only (section 9) is the proposed middle ground.
