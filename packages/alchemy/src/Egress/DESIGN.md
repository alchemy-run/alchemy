# Egress outside Cloudflare (design, not built)

On a Cloudflare Container, the Durable Object intercepts the container's
traffic. A sandbox anywhere else (an AWS microVM, ECS, Fly, a process on your
laptop) has no such hook, so:

- **The sandbox runs a proxy.** Requests to egress hosts go to a gateway;
  every other host goes straight out.
- **The gateway is a handler you route to yourself.** `gateway.fetch` verifies
  the request's grant, runs the egress handler (rules, credentials), and
  streams upstream. It knows nothing about who owns the sandbox, so it can
  run anywhere that serves HTTP: its own Worker (the easiest), your Worker,
  a Lambda with a function URL, a server.
- **The Durable Object that started the sandbox keeps it supplied with grants.**
  A fresh grant (5 minutes by default, `ttl` on `start`) renewed well before it
  expires, pushed to the proxy, plus a new one
  whenever the egress set changes. Revoking means pushing an empty grant and
  then stopping.

```
┌──── microVM ────────────────────────────┐        ┌──── Cloudflare ─────────────────────────────────────────┐
│ git / gh / claude                       │        │                                                         │
│   │ HTTPS_PROXY=http://127.0.0.1:3128   │ HTTPS  │  Gateway: gateway.fetch   (stateless; here a Worker)    │
│   ▼                                     │───────▶│    verify grant → egress handler, narrowed by the grant │
│ proxy (bootstrap)                       │        │    → add the token → stream to api.github.com           │
│   routes the grant's `hosts`            │        │                                                         │
│   other hosts: tunnel straight out      │        │  Api Worker → Durable Object that owns the sandbox      │
│ control port :3129 ◀────────────────────┼────────┤    alarm before expiry: push a fresh grant (ttl)       │
│   (new grant: routing follows it)       │        │    setEgress: push a new grant · revoke: push ""        │
└─────────────────────────────────────────┘        └─────────────────────────────────────────────────────────┘
```

Sections 1–3 are user code, the same on every platform except the Layer in
`alchemy.run.ts`. Sections 4–12 are what Alchemy does underneath.

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

## 2. User code: the Durable Object, the Worker, the sandbox

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
          sandbox.start({
            egress: [model, repo.narrow({ repository: "alchemy-run/alchemy", issue })],
            // How long each grant lives; a grant copied out of the sandbox is useful this long.
            // Default 5 minutes. No effect on a Cloudflare Container (no grants).
            ttl: "5 minutes",
          }),
        // Mid-session: the proxy gets a new grant at once.
        modelOnly: () => sandbox.setEgress([model]),
        // The proxy routes nothing to the gateway from now on; the sandbox stops.
        settle: () => sandbox.stop(),
      };
    });
  }),
) {}
```

```ts
// src/worker.ts — hosts Agent; knows nothing about egress
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Agent } from "./Agent.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const issue = Number(new URL(request.url, "http://x").searchParams.get("issue"));
        yield* (yield* agents.getByName(`issue-${issue}`)).work(issue);
        return HttpServerResponse.text("started");
      }),
    };
  }),
) {}
```

```ts
// src/gateway.ts — its own Worker: sandboxes' egress traffic, nothing else
import * as Cloudflare from "alchemy/Cloudflare";
import * as Egress from "alchemy/Egress";
import { Model, Repo } from "./egress.ts";

// Egress.Gateway is a Worker implementation by itself: it yields `{ fetch }`.
// It binds the egresses' secrets into this Worker, and the root key that verifies grants.
export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

`Egress.Gateway` isn't tied to Workers. The same gateway on a Lambda:

```ts
// src/gateway.ts — a Lambda with a function URL
import * as AWS from "alchemy/AWS";
import * as Egress from "alchemy/Egress";
import { Model, Repo } from "./egress.ts";

// The same bindings, into the Lambda's environment.
export default class Gateway extends AWS.Lambda.Function<Gateway>()(
  "Gateway",
  { main: import.meta.url, url: true },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

Or one Worker, routed by hand:

```ts
// src/worker.ts — hosts Agent and serves egress on /egress
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Egress from "alchemy/Egress";
import { Agent } from "./Agent.ts";
import { Model, Repo } from "./egress.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;
    const gateway = yield* Egress.Gateway({ egress: [Model, Repo] });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/egress") return yield* gateway.fetch;
        const issue = Number(url.searchParams.get("issue"));
        yield* (yield* agents.getByName(`issue-${issue}`)).work(issue);
        return HttpServerResponse.text("started");
      }),
    };
  }),
) {}
```

```ts
// src/Sandbox.ts — the shape the Durable Object uses (start, exec, setEgress, stop).
// No host and no implementation: that's chosen per platform below.
import * as AI from "alchemy/AI";

export class Sandbox extends AI.Sandbox<Sandbox>()("Sandbox") {}
```

There is no `Sandbox.make`. A host constructor takes the declaration, the
host's props, and the program, and the program provides its own layers,
because only code written for a host knows what that host offers:

```ts
// src/Sandbox.microvm.ts — the program on an AWS microVM
import * as Anthropic from "alchemy/Anthropic";
import * as AWS from "alchemy/AWS";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Gateway from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export default AWS.MicroVM.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    memory: "32 GB",
    cpu: 8,
    // Where the proxy sends egress traffic: anything with a `url` (a Worker, a Lambda with a
    // function URL), or a URL string. Routed in your own Worker: `gateway: Api, gatewayPath: "/egress"`.
    gateway: Gateway,
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, AWS.MicroVM.Metadata)),
  ),
);
```

```ts
// src/Sandbox.cloudflare.ts — the same program in a Cloudflare Container
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export default Cloudflare.Containers.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    instance: "standard-4",
    schedulingPolicy: "durable_object",
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
```

A harness server (`Anthropic.ClaudeCodeServer`, `OpenAI.CodexServer`,
`OpenCode.Server`, `AI.AcpServer`) yields `{ fetch }`, so it can be the whole
program, as above. With routes of your own, route to its `fetch`:

```ts
// src/Sandbox.microvm.ts — Claude Code next to your own routes
import * as Anthropic from "alchemy/Anthropic";
import * as AWS from "alchemy/AWS";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import Gateway from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export default AWS.MicroVM.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    memory: "32 GB",
    cpu: 8,
    gateway: Gateway,
  },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url === "/health") return HttpServerResponse.text("ok");
        return yield* claude.fetch;
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, AWS.MicroVM.Metadata))),
);
```

Nothing about the proxy appears in either: on a microVM the bootstrap starts
it (section 8); in a Cloudflare Container there is none (section 12).

## 3. User code: pick the platform

Pick the platform by choosing which implementation to provide:

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SandboxLive from "./src/Sandbox.microvm.ts"; // or ./src/Sandbox.cloudflare.ts
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
  }).pipe(Effect.provide(SandboxLive)),
);
```

## 4. Deploy time: what each egress binds into the sandbox image

`yield* Repo` (in the Durable Object) binds what must be in the image: tools,
placeholders, and the switch that starts the proxy. This is what `Egress.ts`
does today, plus `ALCHEMY_EGRESS_PROXY`:

```ts
// alchemy internal: Egress/Egress.ts, when a declaration is yielded at deploy time
yield* sandbox.bind`Egress(${key})`({
  image: [gitCliLayer, ghCliLayer], // GitHub.Egress; Anthropic.Egress: none
  env: {
    GH_TOKEN: "alchemy-egress", // a placeholder: tools think they're signed in
    ALCHEMY_EGRESS_PROXY: "1", // the bootstrap starts the proxy (non-Cloudflare sandboxes)
  },
});
// The real credential: a secret in whatever yields the declaration (the gateway's host).
yield* worker.bind`Egress(${key})`({ env: { [`ALCHEMY_EGRESS_SECRET_${key}`]: token } });
```

**The image does not list hosts.** Which hosts go to the gateway depends on
the session (narrowing) and changes mid-session (`setEgress`), so it comes
from the grant at runtime (section 8).

## 5. Deploy time: what the microVM Layer binds into the hosting Worker

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts (when the Durable Object yields Sandbox, deploy time)
const worker = yield* Cloudflare.Worker; // the Worker hosting the Durable Object

// Signs grants here; Egress.Gateway yields the same declaration to verify them,
// so the Durable Object's Worker and the gateway's host share one key per stage.
const rootKey = yield* Egress.RootKey; // Random("EgressRootKey", { bytes: 32 })
yield* worker.bind`EgressRootKey`({ env: { ALCHEMY_EGRESS_ROOT_KEY: rootKey.value } });

// Where sandboxes send egress traffic: a URL string as given, or the `url` of the resource given.
const gatewayUrl =
  typeof options.gateway === "string"
    ? options.gateway
    : Output.interpolate`${(yield* options.gateway).url}${options.gatewayPath ?? "/"}`;
yield* worker.bind`EgressGateway`({ env: { ALCHEMY_EGRESS_GATEWAY: gatewayUrl } });

// Starting microVMs.
const launcher = yield* AWS.IAM.Role("SandboxLauncher", {
  /* trust: this Worker; permissions: run/stop microVMs from this image */
});
yield* worker.bind`SandboxLauncher`({ env: { AWS_ROLE_ARN: launcher.roleArn } });
```

## 6. Run time: the Durable Object starts the sandbox and keeps its grant fresh

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — runs in the Durable Object that owns the sandbox
/** What the Durable Object stores per sandbox (section 7): survives an eviction. */
interface EgressState {
  readonly ttl: Duration.Duration; // from start({ ttl }) / setEgress(egress, { ttl })
  readonly egress: ReadonlyArray<EgressRef>;
}
const load = state.storage.get<EgressState>("egress").pipe(
  Effect.map((s) => s ?? { ttl: Duration.minutes(5), egress: [] }),
);
const save = (next: EgressState) => state.storage.put("egress", next);

/** Renew at 40% of the TTL: one push can fail and the next still lands before expiry. */
const renewIn = (ttl: Duration.Duration) => Duration.toMillis(ttl) * 0.4;

/** A grant for this session's egresses: what the sandbox may route to the gateway. */
const mintGrant = ({ ttl, egress }: EgressState) =>
  Grant.encode(
    [
      `expires < ${Date.now() + Duration.toMillis(ttl)}`,
      ...egress.map((e) => `egress ${e.egress} = ${JSON.stringify(e.scope ?? {})}`),
      // e.g. 'egress Repo = {"repository":"alchemy-run/alchemy","issue":42}'
      `hosts = ${egress.flatMap((e) => hostsOf(e)).join(",")}`,
      // e.g. "api.anthropic.com,api.github.com,uploads.github.com,github.com"
    ].reduce(Grant.attenuate, Grant.mint(env.ALCHEMY_EGRESS_ROOT_KEY, "v1")),
  );

/** Hand the proxy a new grant over its control port (section 8). */
const pushGrant = (grant: string) =>
  HttpClient.post(`${machineUrl(3129)}/grant`, {
    body: grant,
    headers: { authorization: `Bearer ${controlSecret}` },
  });

start: ({ egress: given, ttl }) =>
  Effect.gen(function* () {
    // A given set replaces the stored one; no set keeps whatever is stored (setEgress included).
    const stored = yield* load;
    const current: EgressState = {
      ttl: ttl !== undefined ? Duration.decode(ttl) : stored.ttl,
      egress: given !== undefined ? given.map(Egress.toRef) : stored.egress,
    };
    yield* save(current);
    if (yield* running) return yield* pushGrant(mintGrant(current)); // already up: just re-sync
    // Only this Durable Object can change the sandbox's grant; stored with the machine id.
    const controlSecret = crypto.randomUUID();
    yield* state.storage.put("controlSecret", controlSecret);
    yield* microvms.run({
      image: imageRef, // the program's bundle + Alchemy's bootstrap + section 4's layers
      env: {
        ...imageEnv, // GH_TOKEN=alchemy-egress, ALCHEMY_EGRESS_PROXY=1
        ALCHEMY_EGRESS_GATEWAY: env.ALCHEMY_EGRESS_GATEWAY,
        ALCHEMY_EGRESS_GRANT: mintGrant(current), // the first grant
        ALCHEMY_EGRESS_CONTROL_SECRET: controlSecret,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HTTP_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
      },
      ports: [3000, 3129], // the harness; the proxy's control port
    });
    yield* state.storage.setAlarm(Date.now() + renewIn(current.ttl));
  }),

// While the sandbox runs: a fresh grant before the current one expires (every 2 min at the default).
alarm: () =>
  Effect.gen(function* () {
    if (!(yield* running)) return; // stopped: no grant, no renewals
    const current = yield* load; // from storage: correct after an eviction
    yield* pushGrant(mintGrant(current));
    yield* state.storage.setAlarm(Date.now() + renewIn(current.ttl));
  }),

// Stored first: a crash between the two steps still converges on the next alarm.
setEgress: (egress, options) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const current: EgressState = {
      ttl: options?.ttl !== undefined ? Duration.decode(options.ttl) : stored.ttl,
      egress: egress.map(Egress.toRef),
    };
    yield* save(current);
    yield* pushGrant(mintGrant(current));
    yield* state.storage.setAlarm(Date.now() + renewIn(current.ttl)); // a new ttl reschedules
  }),

stop: () =>
  pushGrant("").pipe( // routes nothing from now on
    Effect.andThen(microvms.stop(machineId)),
    Effect.andThen(state.storage.deleteAlarm()),
    // The egress set stays stored: a later start() with no `egress` resumes with it.
  ),
```

## 7. Where egress state lives

Egress is stateless where it can be and stateful in one place: the
Durable Object that owns the sandbox.

```ts
// Stateless, fixed at deploy time: declarations, rules, tokens (in the gateway's host env).
export const Repo = GitHub.Egress(Sandbox, { token: GitHub.ProfileToken, repositories });

// Stateless, self-describing: a grant carries its egresses, scopes, hosts and expiry.
// The gateway needs only the root key to check it.
Grant.verify(env.ALCHEMY_EGRESS_ROOT_KEY, grant);

// Stateful, in the owning Durable Object's storage: the sandbox's egress set and ttl, as data.
yield* state.storage.get("egress");
// {
//   ttl: "5 minutes",
//   egress: [
//     { egress: "Model" },
//     { egress: "Repo", scope: { repository: "alchemy-run/alchemy", issue: 42 } },
//   ],
// }

// Stateful, in the sandbox's memory: the proxy's last pushed grant. A cache of the above.
```

So an egress value is data. `repo.narrow(scope)` returns a declaration key
plus a scope, and the handler is looked up from the key wherever it runs:

```ts
// alchemy internal: Egress/Egress.ts
export interface EgressRef {
  readonly egress: string; // the declaration's key: "Repo"
  readonly scope?: unknown; // what narrow() was given
}
export const toRef = (egress: Egress): EgressRef => ({ egress: egress.key, scope: egress.scope });
```

What `start` and `setEgress` do with it, on every platform:

```ts
yield* sandbox.start({ egress: [model, repo.narrow({ repository, issue })], ttl: "5 minutes" }); // stores, then applies
yield* sandbox.setEgress([model], { ttl: "1 hour" }); // stores, then applies; ttl optional (kept if omitted)
yield* sandbox.start(); // no `egress`: applies whatever is stored (keeps the setEgress above)
yield* sandbox.stop(); // stops; the stored set stays for the next start()
```

Every failure converges from storage:

```ts
// The Durable Object is evicted while the sandbox runs:
//   microVM: the next alarm mints from storage, not from an empty variable.
//   Cloudflare: constructing the Durable Object re-applies the stored set's interception.
// The proxy restarts: its startup grant may have expired; the next alarm (≤40% of ttl) pushes a fresh one.
// A crash between storing and applying: the next alarm / construction applies what's stored.
```

## 8. Run time: the sandbox's bootstrap runs the proxy

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
  // The grant decides routing; it changes whenever the Durable Object pushes one.
  const routed = () => (grant ? new Set(Grant.caveat(grant, "hosts").split(",")) : new Set());
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
      grant = body; // "" routes nothing
      res.writeHead(204).end();
    })
    .listen(3129, "0.0.0.0");
};
```

The proxy never asks anyone for a grant. It uses the one it was last given.

## 9. Run time: the gateway (stateless)

`Egress.Gateway({ egress })` hooks nothing. It binds the root key and the
egresses' secrets into whatever yields it (a Worker, a Lambda, a server), and
returns `fetch`, which the user routes to. This is that `fetch`, written plainly:

```ts
// alchemy internal: Egress/Gateway.ts — gateway.fetch
export const gateway = (egress: ReadonlyArray<EgressDeclaration>) =>
  async (request: Request, env: Env): Promise<Response> => {
    const grant = Grant.decode(request.headers.get("authorization"));
    if (!Grant.verify(env.ALCHEMY_EGRESS_ROOT_KEY, grant)) return new Response("bad grant", { status: 401 });
    if (Number(Grant.caveat(grant, "expires <")) < Date.now()) {
      return new Response("grant expired", { status: 401 });
    }

    const target = new URL(request.headers.get("x-alchemy-target")!);
    // Which granted egress covers this host, and its narrowed scope (from the grant).
    const granted = egress
      .map((e) => ({ e, scope: Grant.egressScope(grant, e.key) }))
      .find(({ e, scope }) => scope !== undefined && e.hosts.includes(target.hostname));
    if (!granted) return new Response(`${target.hostname} is not granted`, { status: 403 });

    // The same handler as on Cloudflare, narrowed as the Durable Object narrowed it:
    // GitHub's rules, refusals in git's / gh's format, the token added, the body streamed.
    return granted.e.narrow(granted.scope).handle(toUpstreamRequest(request, target), env);
  };
```

## 10. Revocation

```ts
// The sandbox loses access at once: the proxy swaps to the new grant before the call returns.
yield* sandbox.setEgress([model]); // GitHub hosts go straight out, without a token
yield* sandbox.stop(); // the proxy gets "", then the microVM stops

// A grant copied out of the sandbox keeps working until its `expires` caveat: at most `ttl`.
```

If a short `ttl` still isn't enough for writes, the next step is a revocation list owned
by the gateway (keyed by grant id, written by the Durable Object, checked on
writes only). The gateway still wouldn't know who owns the sandbox.

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

A grant isn't a credential for GitHub or Anthropic. It lets whoever holds it
ask the gateway to run the egresses it names, as narrowed, for up to 5
minutes. The tokens stay in the gateway's host.

## 12. Cloudflare Containers stay as they are

`src/Sandbox.cloudflare.ts` (section 2) needs no proxy, grant or gateway:
the Durable Object intercepts the container's traffic and runs the same
handlers (built). Two changes for Cloudflare:

```ts
// 1. A bug today: ContainerClient.ts keeps the egress set in memory only.
coordinationFor(container).liveEgress = next; // a WeakMap: gone when the Durable Object is evicted
// - The Durable Object restarts while the container runs: interception is lost, traffic goes
//   direct (fails closed: the placeholder token doesn't authenticate).
// - The next start({ egress }) re-applies the original set, silently undoing setEgress.
// Fix: store the set as EgressRefs (section 7) and re-apply it when the Durable Object is constructed.

// 2. Stream request bodies; today makeEgressHandle reads the whole body.
```

## 13. Every environment

Each host is a constructor over the same `Sandbox` declaration, taking that
host's props and a program that provides that host's layers:

```ts
// Cloudflare Container: interception (built)
Cloudflare.Containers.Sandbox(Sandbox, { main, image, instance: "standard-4" }, program);

// AWS microVM: sections 4–11
AWS.MicroVM.Sandbox(Sandbox, { main, image, memory: "32 GB", cpu: 8, gateway }, program);

// ECS / Fly / Kubernetes: the same proxy and gateway; only how the sandbox starts differs
AWS.ECS.Sandbox(Sandbox, { main, image, cpu: 8, memory: "32 GB", gateway }, program);
Fly.Sandbox(Sandbox, { main, image, size: "performance-8x", gateway }, program);

// A process on your machine under alchemy dev: the same proxy; the gateway runs locally
Local.Sandbox(Sandbox, { main, gateway }, program);
```

## 14. Open questions

1. **Certificates:** the proxy generates X.509 leaf certificates, which Node can't do natively. Use `@peculiar/x509`, or write the proxy in Go?
2. **The control port** needs the platform to expose port 3129 to the Durable Object only (a security group or private networking). Over the public internet, the control secret is the only protection.
3. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, since the sandbox has none, but it does skip the rules for non-egress hosts. Closing it needs a firewall that only allows the Worker.
4. **A missed renewal:** if the Durable Object can't reach the control port for a whole `ttl`, the sandbox's grant expires and egress stops until the next push. Is that the right failure, or should the proxy fall back to asking?
