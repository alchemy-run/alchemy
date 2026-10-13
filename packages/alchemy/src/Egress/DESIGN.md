# Egress outside Cloudflare: proxy + gateway (design, not built)

On a Cloudflare Container, egress works because the Durable Object can
intercept the container's traffic. A sandbox anywhere else (an AWS microVM,
ECS, EC2, Fly, Kubernetes, a process on your laptop) has no such hook. So:

1. the sandbox runs a **proxy** that every tool talks to (`HTTPS_PROXY`),
2. the proxy forwards each request to a **gateway** on a Cloudflare Worker,
3. the gateway runs the **same egress handlers** and adds the credentials,
4. the proxy proves it may use them with a **grant** (a macaroon) minted by
   the control plane for that session.

The credentials live only in the gateway Worker. The sandbox holds a grant
that expires in minutes and covers only its session's egress.

```
┌──────────── sandbox (microVM) ────────────┐        ┌──── Cloudflare ────────────────────┐
│ git / gh / claude                          │        │                                    │
│   │ HTTPS_PROXY=http://127.0.0.1:3128      │        │  EgressGateway Worker               │
│   ▼                                        │  TLS   │   POST /egress                      │
│ alchemy egress proxy ──────────────────────┼───────▶│   1. verify grant (HMAC, caveats)   │
│   • terminates TLS for egress hosts        │        │   2. run the egress handler         │
│     (per-sandbox CA, trusted via           │        │      (GitHub rules, add token)      │
│      SSL_CERT_FILE etc.)                   │        │   3. fetch upstream, stream back    │
│   • sends the request + grant to gateway   │        │                                    │
│   • other hosts: tunnels straight out      │        │  Agent Durable Object (control)     │
│   • refreshes its grant before expiry ─────┼───────▶│   POST /egress/refresh → mints a    │
└────────────────────────────────────────────┘        │   new grant (or refuses: revoked)   │
                                                      └────────────────────────────────────┘
```

## 1. Declare the egresses (portable; no container argument)

```ts
// src/egress.ts
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";

export const Model = Anthropic.Egress("Model", {
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
});

export const Repo = GitHub.Egress("Repo", {
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

Each declaration carries:

- `hosts`: `api.anthropic.com`, and `api.github.com` / `uploads.github.com` / `github.com`
- `handle(request, scope)`: the same handler the Durable Object runs today
- `secrets`: bound into whichever Worker yields the declaration
- `sandbox`: placeholder env (`GH_TOKEN=alchemy-egress`) and tools (`gh`, `git`) for the image

## 2. The gateway Worker

```ts
// src/gateway.ts
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Agent } from "./Agent.ts";
import { Model, Repo } from "./egress.ts";

export default class EgressGateway extends Cloudflare.Worker<EgressGateway>()(
  "EgressGateway",
  { main: import.meta.url },
  Effect.gen(function* () {
    const gateway = yield* AI.EgressGateway({
      // Yielding binds each egress's secrets (ANTHROPIC_API_KEY, the GitHub
      // token) into THIS Worker, and a generated root key for grants.
      egress: [Model, Repo],
      // Refreshes and revocation are answered by the session's Durable Object.
      control: Agent,
    });
    return { fetch: gateway.fetch }; // serves POST /egress and POST /egress/refresh
  }),
) {}
```

`AI.EgressGateway` does this at deploy time:

```ts
// what AI.EgressGateway binds into the Worker (deploy time)
env.ALCHEMY_EGRESS_ROOT_KEY       // Random(32 bytes), a Secret; never leaves this Worker
env.ALCHEMY_EGRESS_SECRET_Model   // Redacted ANTHROPIC_API_KEY
env.ALCHEMY_EGRESS_SECRET_Repo    // Redacted GitHub token
env.Agent                         // the control-plane Durable Object namespace
```

## 3. The sandbox program (unchanged)

```ts
// src/Sandbox.ts
import * as AI from "alchemy/AI";

export class Sandbox extends AI.Sandbox<Sandbox>()("Sandbox") {}
```

```ts
// src/Sandbox.runtime.ts
import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import { Dockerfile } from "alchemy/Docker";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export default Sandbox.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: Dockerfile.inline`
      FROM node:24-bookworm
      RUN corepack enable
    `,
  },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
```

Nothing here mentions the proxy. Alchemy's bootstrap (the code that runs
before the program) starts the proxy whenever `ALCHEMY_EGRESS_GATEWAY` is
set. See section 6.

## 4. The control plane: start a microVM with a grant

```ts
// src/Agent.ts
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Model, Repo } from "./egress.ts";
import EgressGateway from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const sandbox = yield* Sandbox; // AWS.MicroVM.Sandbox provides this (alchemy.run.ts)
    const gateway = yield* AI.EgressGrants(EgressGateway); // mints grants for that gateway
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      return {
        work: (issue: number) =>
          Effect.gen(function* () {
            yield* sandbox.start({
              egress: [Model, Repo.narrow({ repository: "alchemy-run/alchemy", issue })],
            });
          }),

        // Called by the gateway when a sandbox's grant is about to expire.
        refreshGrant: (grant: string) => gateway.refresh(grant, { session: state.id.toString() }),
        // Settle / stop: grants for this session are no longer refreshed.
        revoke: () => gateway.revoke({ session: state.id.toString() }),
      };
    });
  }),
) {}
```

What `sandbox.start({ egress })` does on AWS (inside `AWS.MicroVM.Sandbox`):

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts, start()
const grant = yield* grants.mint({
  session,                         // this Durable Object's id
  egress: options.egress,          // [Model, Repo narrowed to issue 42]
  ttl: "15 minutes",
});
yield* microvm.run({
  image,                           // built on AWS's builder; includes the egresses' tools (gh, git)
  env: {
    GH_TOKEN: "alchemy-egress",    // placeholders from the egress declarations
    ANTHROPIC_API_KEY: "alchemy-egress",
    ALCHEMY_EGRESS_GATEWAY: "https://egressgateway-<stage>.workers.dev/egress",
    ALCHEMY_EGRESS_GRANT: grant,   // the only credential the sandbox gets
    HTTPS_PROXY: "http://127.0.0.1:3128",
    HTTP_PROXY: "http://127.0.0.1:3128",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",       // Node's fetch honors HTTPS_PROXY only with this
  },
});
```

## 5. The stack

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import EgressGateway from "./src/gateway.ts";
import SandboxLive from "./src/Sandbox.runtime.ts";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const gateway = yield* EgressGateway;
    const api = yield* Api;
    return { api: api.url.as<string>(), gateway: gateway.url.as<string>() };
  }).pipe(Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 }))),
);
```

## 6. The proxy (alchemy internal, in the sandbox's bootstrap)

```ts
// alchemy internal: Runtime/Bootstrap/EgressProxy.ts
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { decodeGrant } from "../../Egress/Grant.ts";
import { makeLocalCa } from "../../Egress/LocalCa.ts";

export const startEgressProxy = async () => {
  const gatewayUrl = process.env.ALCHEMY_EGRESS_GATEWAY;
  if (!gatewayUrl) return;
  let grant = process.env.ALCHEMY_EGRESS_GRANT!;

  // The hosts this sandbox's egresses cover come from the grant itself.
  const hosts = () => new Set(decodeGrant(grant).hosts);

  // A CA made at boot; programs trust it through the bundle the bootstrap
  // already writes (SSL_CERT_FILE, GIT_SSL_CAINFO, NODE_EXTRA_CA_CERTS, …).
  const ca = await makeLocalCa("/tmp/alchemy-egress-ca.pem");

  // Requests to egress hosts, after TLS is terminated: hand them to the gateway.
  const forward = (req: http.IncomingMessage, res: http.ServerResponse, host: string) => {
    const upstream = http.request(gatewayUrl, {
      method: "POST",
      headers: {
        ...req.headers,
        authorization: `Macaroon ${grant}`,
        "x-alchemy-target": `https://${host}${req.url}`,
        "x-alchemy-method": req.method!,
      },
    });
    upstream.on("response", (gw) => {
      res.writeHead(gw.statusCode!, gw.headers);
      gw.pipe(res);
    });
    req.pipe(upstream);
  };

  const server = http.createServer();
  server.on("connect", (req, client, head) => {
    const [host, port = "443"] = req.url!.split(":");
    if (hosts().has(host!)) {
      // An egress host: terminate TLS with a leaf cert for `host`, signed by our CA.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const tlsSocket = new tls.TLSSocket(client, { isServer: true, ...ca.leafFor(host!) });
      http.createServer((r, s) => forward(r, s, host!)).emit("connection", tlsSocket);
    } else {
      // Anything else: a plain tunnel (or refuse, when the sandbox has no internet).
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client).pipe(upstream);
      });
    }
  });
  server.listen(3128, "127.0.0.1");

  // Refresh the grant before it expires; the control plane may refuse (revoked).
  setInterval(async () => {
    const res = await fetch(`${gatewayUrl}/refresh`, {
      method: "POST",
      headers: { authorization: `Macaroon ${grant}` },
    });
    if (res.ok) grant = await res.text();
  }, 10 * 60_000);
};
```

The leaf certificates need X.509 generation, which Node lacks. Use
`@peculiar/x509` over WebCrypto, or write the proxy in Go as a static binary.

## 7. On the wire

From the sandbox to the gateway, a `gh issue comment 42` becomes:

```http
POST /egress HTTP/1.1
Host: egressgateway-prod.workers.dev
Authorization: Macaroon eyJpZCI6ImRlcGxveW1lbnQtMSIsImNhdmVhdHMiOlsi…
X-Alchemy-Target: https://api.github.com/repos/alchemy-run/alchemy/issues/42/comments
X-Alchemy-Method: POST
Content-Type: application/json

{"body":"Fixed in #2210"}
```

The sandbox's placeholder `Authorization: token alchemy-egress` never leaves
the proxy: the grant takes its place. The gateway sends upstream:

```http
POST /repos/alchemy-run/alchemy/issues/42/comments HTTP/1.1
Host: api.github.com
Authorization: token gho_<the real token, from the gateway's secret>
Content-Type: application/json

{"body":"Fixed in #2210"}
```

## 8. Grants (macaroons)

```ts
// alchemy internal: Egress/Grant.ts
import { createHmac } from "node:crypto";

export interface Grant {
  readonly id: string;                    // which root key
  readonly caveats: ReadonlyArray<string>;
  readonly signature: string;             // hex
}

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** Root grant: only the gateway (or its control plane) can make one. */
export const mint = (rootKey: Buffer, id: string): Grant => ({
  id,
  caveats: [],
  signature: hmac(rootKey, id).toString("hex"),
});

/** Anyone holding a grant can narrow it; no one can widen it. */
export const attenuate = (grant: Grant, caveat: string): Grant => ({
  id: grant.id,
  caveats: [...grant.caveats, caveat],
  signature: hmac(Buffer.from(grant.signature, "hex"), caveat).toString("hex"),
});

/** The gateway recomputes the chain from the root key. */
export const verify = (rootKey: Buffer, grant: Grant): boolean => {
  let signature = hmac(rootKey, grant.id);
  for (const caveat of grant.caveats) signature = hmac(signature, caveat);
  return signature.toString("hex") === grant.signature;
};
```

A session grant, as minted by `sandbox.start`:

```ts
const sessionGrant = [
  "session = 7f3a9c…", // the Agent Durable Object
  "expires < 2026-10-13T16:30:00Z",
  'egress Model = {}',
  'egress Repo = {"repository":"alchemy-run/alchemy","issue":42}', // the narrowed scope
].reduce(attenuate, mint(rootKey, "harness-prod-1"));
```

What the gateway checks on every request:

```ts
// alchemy internal: Egress/Gateway.ts, POST /egress
const grant = decodeGrant(request.headers.authorization);
if (!verify(rootKey, grant)) return refuse(401, "bad grant");
const caveats = parseCaveats(grant.caveats);
if (caveats.expires < Date.now()) return refuse(401, "grant expired");
const target = new URL(request.headers["x-alchemy-target"]);
const egress = egresses.find((e) => e.hosts.includes(target.hostname));
const scope = egress && caveats.egress[egress.key]; // undefined: not granted
if (!egress || scope === undefined) return refuse(403, `${target.hostname} is not granted`);
// Writes are rare and where damage happens: check revocation for them.
if (isWrite(request) && (yield* control(caveats.session).revoked())) return refuse(403, "revoked");
return yield* egress.handle(toUpstream(request, target), scope); // same handler as on Cloudflare
```

## 9. Revocation

```ts
yield* agent.settle(); // or stop / delete: the Agent marks the session revoked
```

- **Refresh:** `POST /egress/refresh` asks the session's Agent, which refuses once the session is revoked. A leaked grant dies within its 15-minute expiry.
- **Writes** (push, comment, merge) check revocation on every request, so they stop at once.

## 10. Where each environment gets its sandbox and egress

```ts
// Cloudflare Container: interception, no proxy, no grant
Effect.provide(Cloudflare.Containers.Sandbox(SandboxLive, { instance: "standard-4" }));

// AWS microVM: proxy + gateway + grant (sections 4, 6, 7, 8)
Effect.provide(AWS.MicroVM.Sandbox(SandboxLive, { memory: "32 GB", cpu: 8 }));

// ECS / EC2 / Fly / Kubernetes: the same proxy + gateway; only how the sandbox is started differs
Effect.provide(AWS.ECS.Sandbox(SandboxLive, { cpu: 8, memory: "32 GB" }));
Effect.provide(Fly.Sandbox(SandboxLive, { size: "performance-8x" }));

// A process on your machine (alchemy dev): the same proxy, and the gateway is the dev Worker
Effect.provide(Local.Sandbox(SandboxLive));
```

## 11. Open questions

1. **Proxy language:** Node with `@peculiar/x509`, or a Go static binary (no runtime in the image, faster TLS)?
2. **Proof of possession:** should the proxy also sign each request with a per-sandbox key, so a leaked grant is useless outside the sandbox? It's v2-worthy; v1 relies on the 15-minute expiry.
3. **Strict mode:** a firewall on the sandbox that allows only the gateway, so tools that ignore `HTTPS_PROXY` can't reach anything. This needs platform security groups or iptables.
4. **Builds:** image builds that need a private repository could run the same proxy with a short build grant.
