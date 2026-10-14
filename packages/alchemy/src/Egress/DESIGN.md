# Egress (design)

A sandbox holds no credentials. Its requests to egress hosts (GitHub,
Anthropic, …) go to an **egress gateway**, which checks them against the
egress rules, adds the real token, and forwards them. Every other host goes
straight out.

The gateway is the same everywhere. It's something you set up, like any other
Worker, and pass to a sandbox when you start it:

```ts
const gateway = yield* Egress.connect(Gateway);
yield* sandbox.start({ size: "large", gateway, egress: [model, repo.narrow({ issue })] });
```

Only the transport differs by host. A Cloudflare Container reaches the gateway
over a native Worker binding. Anywhere else, a proxy in the sandbox reaches it
over HTTPS. Either way, every request carries a short-lived signed **grant**
saying which egresses it may use, and the Durable Object that owns the sandbox
keeps that grant fresh. Nothing is decided at build time: the gateway and the
grant are pushed to the sandbox at run time, and can change while it runs.

```
                         Durable Object that owns the sandbox
                           decides: gateway, egresses, ttl (stored)
                           mints a grant with the gateway's key, renews it
                                │ push { gateway, grant }
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
Cloudflare Container                     microVM / ECS / Fly / local
  git push                                 git push
   └ interceptOutboundHttps                 └ proxy :3128 (HTTPS_PROXY)
     → relay entrypoint (props)               routes the grant's hosts
     → service binding ─────────┐             → HTTPS + grant ──────┐
                                ▼                                   ▼
                     Egress gateway (a Worker, a Lambda, …): verify grant
                       → egress handler (rules, token) → api.github.com
```

## 1. Declare the egresses

```ts
// src/egress.ts
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import { Sandbox } from "./Sandbox.ts";

// Module-level declarations: the gateway runs their handlers; the Durable Object grants them.
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

## 2. Set up an egress gateway

`Egress.Gateway` is a whole Worker implementation by itself. It binds the
egresses' secrets and its own signing key into the Worker, and serves
`fetch`:

```ts
// src/gateway.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Egress from "alchemy/Egress";
import { Model, Repo } from "./egress.ts";

export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

It can run anywhere that serves HTTP. The same gateway on a Lambda:

```ts
// src/gateway.ts
import * as AWS from "alchemy/AWS";
import * as Egress from "alchemy/Egress";
import { Model, Repo } from "./egress.ts";

export default class Gateway extends AWS.Lambda.Function<Gateway>()(
  "Gateway",
  { main: import.meta.url, url: true },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

Or inside a Worker you already have, routed by hand:

```ts
// src/worker.ts
const gateway = yield* Egress.Gateway({ egress: [Model, Repo] });
return {
  fetch: Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (new URL(request.url, "http://x").pathname === "/egress") return yield* gateway.fetch;
    // ...
  }),
};
```

You can have several gateways (per team, per region, per set of
credentials). A sandbox uses whichever one it's given at `start`.

## 3. Declare the sandbox and its hosts

```ts
// src/Sandbox.ts — the shape the Durable Object uses: start, exec, setEgress, stop
import * as AI from "alchemy/AI";

// The size names are part of the declaration: they type start({ size }).
export class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large" }>()("Sandbox") {}
```

A host constructor takes the declaration, the host's props and the program.
The program provides its own layers, because only code written for a host
knows what that host offers. Hosts say nothing about gateways:

```ts
// src/Sandbox.cloudflare.ts
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
    // A name is an instance type, chosen at start(): no extra builds.
    sizes: { small: "basic", large: "standard-4" },
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
```

```ts
// src/Sandbox.microvm.ts
import * as Anthropic from "alchemy/Anthropic";
import * as AWS from "alchemy/AWS";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandbox } from "./Sandbox.ts";

export default AWS.MicroVM.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    // One microVM image per name, built at deploy; start() picks the image.
    sizes: { small: "4 GB", large: "32 GB" },
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, AWS.MicroVM.Metadata)),
  ),
);
```

Sizes are named, not measured, because hosts size differently. A Cloudflare
Container picks its instance type at `start()`. A Lambda microVM's memory is
fixed on its image (`CreateMicrovmImage.resources`; `RunMicrovm` has no size),
so each size is its own image. Each host maps every declared name; a missing
or extra name doesn't compile:

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts
export const Sandbox = <S extends AI.Sandbox.Any>(
  sandbox: S,
  props: { sizes: Record<AI.Sandbox.Size<S>, `${number} GB`>; /* main, image, … */ },
  program: Effect.Effect<SandboxShape, never, SandboxServices>,
) => ...

AWS.MicroVM.Sandbox(Sandbox, { sizes: { small: "4 GB" } }, program);
// ✗ Property 'large' is missing in type '{ small: "4 GB" }'
```

A harness server (`Anthropic.ClaudeCodeServer`, `OpenAI.CodexServer`,
`OpenCode.Server`, `AI.AcpServer`) yields `{ fetch }`, so it can be the whole
program, as above. Next to your own routes, route to its `fetch`:

```ts
Effect.gen(function* () {
  const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.url === "/health") return HttpServerResponse.text("ok");
      return yield* claude.fetch;
    }),
  };
});
```

## 4. Start a sandbox with a gateway and its egresses

```ts
// src/Agent.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { Model, Repo } from "./egress.ts";
import Gateway from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const model = yield* Model;
    const repo = yield* Repo;
    const sandbox = yield* Sandbox;
    // A handle to the gateway: how to reach it, and the key to sign its grants.
    const gateway = yield* Egress.connect(Gateway);

    return Effect.gen(function* () {
      return {
        work: (issue: number) =>
          sandbox.start({
            size: "large",
            gateway,
            egress: [model, repo.narrow({ repository: "alchemy-run/alchemy", issue })],
            ttl: "5 minutes", // each grant's lifetime (the default)
          }),
        // Applies at once, on live connections too.
        modelOnly: () => sandbox.setEgress({ egress: [model] }),
        // The gateway is a run-time value: switch it without restarting the sandbox.
        moveTo: (other: Egress.GatewayHandle) => sandbox.setEgress({ gateway: other }),
        settle: () => sandbox.stop(),
      };
    });
  }),
) {}
```

```ts
// src/worker.ts — hosts Agent
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

If `start` grants an egress the gateway doesn't serve, the gateway refuses it
(`github.com is not granted`): it fails closed.

## 5. Pick the platform

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SandboxLive from "./src/Sandbox.cloudflare.ts"; // or ./src/Sandbox.microvm.ts
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api; // pulls in Agent, and through Egress.connect, the Gateway
    return { api: api.url.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
```

## 6. What `Egress.connect` gives the Durable Object

```ts
// alchemy internal: Egress/Gateway.ts
export interface GatewayHandle {
  readonly id: string; // stable: stored with the sandbox's egress set
  readonly url: string; // the gateway's public URL (HTTPS transport)
  readonly fetcher?: Cloudflare.Fetcher; // a service binding, when the gateway is a Worker
  /** Sign a grant for these egresses, with this gateway's key. */
  grant(egress: ReadonlyArray<EgressRef>, ttl: Duration.Duration): Effect.Effect<Grant>;
}

export const connect = (gateway: GatewayDeclaration) =>
  Effect.gen(function* () {
    const host = yield* Cloudflare.Worker; // the Worker hosting the Durable Object
    const target = yield* gateway;
    // Deploy time: the gateway's signing key, its URL, and (for a Worker) a service binding.
    yield* host.bind`EgressGateway(${target.id})`({
      env: { [`ALCHEMY_EGRESS_KEY_${target.id}`]: target.signingKey, [`ALCHEMY_EGRESS_URL_${target.id}`]: target.url },
      ...(target.isWorker ? { bindings: [{ type: "service", name: `ALCHEMY_EGRESS_${target.id}`, service: target.workerName }] } : {}),
    });
    return makeHandle(target.id); // reads those bindings at run time
  });
```

Each gateway owns its key (`Random("EgressKey", { bytes: 32 })`, declared by
`Egress.Gateway`). `connect` binds it into the Worker that hosts the Durable
Object, so grants are minted locally, without a call to the gateway.

## 7. How a sandbox's traffic reaches the gateway

The sandbox learns its gateway and grant at run time. Both transports get the
same thing from the Durable Object:

```ts
interface Route {
  readonly gateway: { readonly id: string; readonly url: string }; // which gateway, and its URL
  readonly grant: string; // encoded; "" routes nothing
}
```

### Cloudflare Container: intercept into a relay entrypoint

The Durable Object intercepts each granted host into its own Worker's
`AlchemyEgress` entrypoint (#2251's `ctx.exports`), with the route in the
props. The relay runs in the Worker, never in the Durable Object, and the
container can't see the props:

```ts
// alchemy internal: Cloudflare/Containers/ContainerClient.ts — in the owning Durable Object
const applyRoute = (route: Route, hosts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ctx = yield* Cloudflare.DurableObjectState;
    const relay = yield* ctx.exports.AlchemyEgress({ props: route });
    for (const host of hosts) yield* container.interceptOutboundHttps(host, relay);
    const deny = yield* ctx.exports.AlchemyEgress({ props: { gateway: route.gateway, grant: "" } });
    for (const host of removedHosts) yield* container.interceptOutboundHttps(host, deny);
  });
```

```ts
// alchemy internal: the generated Worker entry exports AlchemyEgress next to `default`
export class AlchemyEgress extends WorkerEntrypoint {
  fetch(request: Request) {
    const { gateway, grant } = this.ctx.props as Route;
    if (!grant) return new Response("alchemy egress: this host is not allowed\n", { status: 403 });
    const forwarded = toGatewayRequest(request, grant); // Authorization: Macaroon <grant>, x-alchemy-target
    // A gateway Worker: native binding, no public hop. Anything else: its URL.
    const binding = this.env[`ALCHEMY_EGRESS_${gateway.id}`] as Fetcher | undefined;
    return binding ? binding.fetch(forwarded) : fetch(gateway.url, forwarded);
  }
}
```

Calling `interceptOutboundHttps` again with new props replaces them, even on
open connections, so a new grant, `setEgress` and `stop` apply at once.

### Anywhere else: a proxy in the sandbox

The image gets the proxy switch, tools and placeholders at deploy time. No
gateway and no hosts: those arrive at run time.

```ts
// alchemy internal: Egress/Egress.ts, when a declaration is yielded at deploy time
yield* sandbox.bind`Egress(${key})`({
  image: [gitCliLayer, ghCliLayer], // GitHub.Egress; Anthropic.Egress: none
  env: {
    GH_TOKEN: "alchemy-egress", // a placeholder: tools think they're signed in
    ALCHEMY_EGRESS_PROXY: "1", // the bootstrap starts the proxy (non-Cloudflare hosts)
  },
});
```

```ts
// alchemy internal: Runtime/Bootstrap/index.ts — the image's entrypoint, before `main`
await trustEgressCa(); // exists today: writes the CA bundle, sets SSL_CERT_FILE etc.
if (process.env.ALCHEMY_EGRESS_PROXY) {
  await startEgressProxy({
    route: JSON.parse(process.env.ALCHEMY_EGRESS_ROUTE ?? '{"grant":""}'), // the first route, from start()
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
  readonly route: Route;
  readonly controlSecret: string;
}) => {
  let route = options.route;
  // The grant decides which hosts go to the gateway; both change whenever the Durable Object pushes.
  const routed = () => new Set(route.grant ? Grant.hosts(Grant.decodeUnverified(route.grant)) : []);
  const ca = await makeLocalCa("/etc/cloudflare/certs/cloudflare-containers-ca.crt");

  const toGateway = (req: http.IncomingMessage, res: http.ServerResponse, host: string) => {
    const out = http.request(route.gateway.url, {
      method: "POST",
      headers: {
        ...req.headers,
        authorization: `Macaroon ${route.grant}`, // replaces the placeholder credential
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

  // :3128 — what HTTPS_PROXY points at
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    const [host, port = "443"] = req.url!.split(":");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (routed().has(host!)) {
      const decrypted = new tls.TLSSocket(socket, { isServer: true, ...ca.leafFor(host!) });
      http.createServer((r, s) => toGateway(r, s, host!)).emit("connection", decrypted);
    } else {
      // npm, PyPI, docs: straight out, never through the gateway
      const upstream = net.connect(Number(port), host);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }
  });
  proxy.listen(3128, "127.0.0.1");

  // :3129 — only the Durable Object (holding controlSecret) can change the route
  http
    .createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${options.controlSecret}`) {
        return void res.writeHead(401).end();
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      route = JSON.parse(body); // a new gateway, a new grant, or { grant: "" } to route nothing
      res.writeHead(204).end();
    })
    .listen(3129, "0.0.0.0");
};
```

## 8. The gateway's `fetch`

The same on every transport, and stateless: a grant is checked with the
gateway's own key, nothing else.

```ts
// alchemy internal: Egress/Gateway.ts
export const Gateway = (options: { readonly egress: ReadonlyArray<EgressDeclaration> }) =>
  Effect.gen(function* () {
    const key = yield* Random("EgressKey", { bytes: 32 }); // bound into this host; `connect` shares it
    for (const declaration of options.egress) yield* declaration; // binds each secret into this host
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const grant = yield* Grant.decode(request.headers.authorization);
        if (!(yield* Grant.verify(key, grant))) return HttpServerResponse.text("bad grant", { status: 401 });
        const target = new URL(request.headers["x-alchemy-target"]!);
        const ref = Grant.allowed(grant, target.hostname, Date.now()); // expiry + hosts + egress caveats
        if (!ref) return HttpServerResponse.text(`${target.hostname} is not granted`, { status: 403 });
        // Rules, refusals in git's / gh's format, the token, the body streamed.
        const handle = yield* handlerFor(ref);
        return yield* handle(toUpstreamRequest(request, target));
      }),
    };
  });
```

An egress travels as data, and the gateway rebuilds its handler from it:

```ts
// alchemy internal: Egress/Egress.ts
export interface EgressRef {
  readonly egress: string; // the declaration's key: "Repo"
  readonly scope?: unknown; // what narrow() was given: { repository, issue }
}

// Filled when the declaring module loads; the gateway's entry imports its declarations.
const declarations = new Map<string, EgressDeclaration>();

/** Rules from the declaration, scope from the grant, token from this host's env. */
export const handlerFor = (ref: EgressRef) =>
  Effect.gen(function* () {
    const declaration = declarations.get(ref.egress);
    if (!declaration) return yield* new EgressNotServed({ egress: ref.egress });
    return yield* declaration.handler(ref.scope);
  });
```

## 9. Keeping the route fresh

The Durable Object stores the decision and renews the grant before it
expires. Only `apply` differs by host (intercept props, or a push to the
proxy's control port):

```ts
// alchemy internal: AI/Sandbox.ts — shared by every host, runs in the owning Durable Object
interface EgressState {
  readonly gateway: string; // GatewayHandle.id
  readonly ttl: Duration.Duration;
  readonly egress: ReadonlyArray<EgressRef>;
}
const load = state.storage.get<EgressState>("egress");
const save = (next: EgressState) => state.storage.put("egress", next);

/** Renew at 40% of the TTL: one renewal can fail and the next still lands before expiry. */
const renewIn = (ttl: Duration.Duration) => Duration.toMillis(ttl) * 0.4;

const route = (s: EgressState) =>
  Effect.gen(function* () {
    const gateway = gatewayHandle(s.gateway);
    const grant = yield* gateway.grant(s.egress, s.ttl);
    return { gateway: { id: gateway.id, url: gateway.url }, grant: Grant.encode(grant) };
  });

const refresh = (s: EgressState) =>
  Effect.gen(function* () {
    yield* host.apply(yield* route(s)); // Cloudflare: re-intercept; elsewhere: push to :3129
    yield* state.storage.setAlarm(Date.now() + renewIn(s.ttl));
  });

start: ({ size, gateway, egress, ttl }) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const next: EgressState = {
      gateway: gateway?.id ?? stored!.gateway,
      ttl: ttl !== undefined ? Duration.decode(ttl) : (stored?.ttl ?? Duration.minutes(5)),
      egress: egress !== undefined ? egress.map(Egress.toRef) : (stored?.egress ?? []),
    };
    yield* save(next); // stored first: a crash before applying converges on the next alarm
    if (!(yield* host.running)) yield* host.launch({ size, route: yield* route(next) });
    yield* refresh(next);
  }),

alarm: () =>
  Effect.gen(function* () {
    const s = yield* load;
    if (s && (yield* host.running)) yield* refresh(s); // from storage: correct after an eviction
  }),

setEgress: ({ gateway, egress, ttl }) =>
  Effect.gen(function* () {
    const s = (yield* load)!;
    const next: EgressState = {
      gateway: gateway?.id ?? s.gateway,
      ttl: ttl !== undefined ? Duration.decode(ttl) : s.ttl,
      egress: egress !== undefined ? egress.map(Egress.toRef) : s.egress,
    };
    yield* save(next);
    yield* refresh(next);
  }),

stop: () =>
  host.apply({ gateway: undefined, grant: "" }).pipe( // routes nothing from now on
    Effect.andThen(host.stop()),
    Effect.andThen(state.storage.deleteAlarm()),
  ),
```

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — the microVM host
launch: ({ size, route }) =>
  Effect.gen(function* () {
    const controlSecret = crypto.randomUUID();
    yield* state.storage.put("controlSecret", controlSecret);
    yield* microvms.run({
      imageIdentifier: imageFor[size], // one image per declared size, built at deploy
      env: {
        ...imageEnv, // GH_TOKEN=alchemy-egress, ALCHEMY_EGRESS_PROXY=1
        ALCHEMY_EGRESS_ROUTE: JSON.stringify(route), // the first gateway + grant
        ALCHEMY_EGRESS_CONTROL_SECRET: controlSecret,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HTTP_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
      },
      ports: [3000, 3129], // the harness; the proxy's control port
    });
  }),

apply: (route) =>
  HttpClient.post(`${machineUrl(3129)}/route`, {
    body: JSON.stringify(route),
    headers: { authorization: `Bearer ${controlSecret}` },
  }),
```

## 10. Grants (WebCrypto, no dependency)

An HMAC chain over structured caveats: the useful part of macaroons, without
third-party caveats or the binary format. WebCrypto runs on Workers, Node,
Bun and Lambda alike.

```ts
// alchemy internal: Egress/Grant.ts
export type Caveat =
  | { readonly expires: number }
  | { readonly egress: string; readonly scope?: unknown }
  | { readonly hosts: ReadonlyArray<string> };

export interface Grant {
  readonly id: string;
  readonly caveats: ReadonlyArray<Caveat>;
  readonly signature: string; // hex HMAC-SHA256
}

const hmac = (key: Uint8Array, data: string) =>
  Effect.promise(async () => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  });

/** sig₀ = HMAC(rootKey, id); sigₙ = HMAC(sigₙ₋₁, caveatₙ) */
const chain = (rootKey: Uint8Array, id: string, caveats: ReadonlyArray<Caveat>) =>
  Effect.gen(function* () {
    let signature = yield* hmac(rootKey, id);
    for (const caveat of caveats) signature = yield* hmac(signature, JSON.stringify(caveat));
    return signature;
  });

export const mint = (rootKey: Uint8Array, id: string, caveats: ReadonlyArray<Caveat>) =>
  chain(rootKey, id, caveats).pipe(Effect.map((sig): Grant => ({ id, caveats, signature: toHex(sig) })));

/** Anyone holding a grant can narrow it; nobody can widen it without the root key. */
export const attenuate = (grant: Grant, caveat: Caveat) =>
  hmac(fromHex(grant.signature), JSON.stringify(caveat)).pipe(
    Effect.map((sig): Grant => ({ ...grant, caveats: [...grant.caveats, caveat], signature: toHex(sig) })),
  );

export const verify = (rootKey: Uint8Array, grant: Grant) =>
  chain(rootKey, grant.id, grant.caveats).pipe(
    Effect.map((sig) => constantTimeEqual(sig, fromHex(grant.signature))),
  );

/** On the wire: base64url JSON. */
export const encode = (grant: Grant) => toBase64Url(JSON.stringify(grant));
```

A grant isn't a credential for GitHub or Anthropic. It lets its holder ask the
gateway to run the egresses it names, as narrowed, until it expires. The
tokens stay in the gateway's host, and so does its key (shared only with the
Workers that `connect` to it).

## 11. Where egress state lives

```ts
// Fixed at deploy time: declarations, rules and tokens (the gateway's host), the gateway's key.
export const Repo = GitHub.Egress(Sandbox, { token: GitHub.ProfileToken, repositories });

// Decided at run time, stored by the owning Durable Object:
yield* state.storage.get("egress");
// {
//   gateway: "Gateway",
//   ttl: "5 minutes",
//   egress: [{ egress: "Model" }, { egress: "Repo", scope: { repository, issue: 42 } }],
// }

// Applied copies: a grant (and the gateway's URL) in the intercept props or the proxy's memory.
```

```ts
yield* sandbox.start({ size, gateway, egress, ttl }); // stores, applies
yield* sandbox.setEgress({ egress: [model] }); // stores, applies; omitted fields are kept
yield* sandbox.setEgress({ gateway: other }); // switch gateways while running
yield* sandbox.start({ size }); // no gateway/egress: re-applies what's stored
yield* sandbox.stop(); // stops; the stored decision stays for the next start()
```

Every failure converges from storage:

```ts
// The Durable Object is evicted while the sandbox runs: the next alarm (≤40% of ttl) re-applies.
// The proxy restarts: its startup grant may have expired; the next alarm pushes a fresh route.
// A crash between storing and applying: the next alarm applies what's stored.
```

## 12. Revocation

```ts
// The sandbox loses access at once, on every host:
yield* sandbox.setEgress({ egress: [model] }); // a new, narrower grant replaces the old one
yield* sandbox.stop(); // { grant: "" }: routes nothing

// A grant copied out of the sandbox works until it expires: at most `ttl`.
// On Cloudflare the grant is in the intercept props, which the container can't read.
```

If `ttl` is ever too long for writes, a gateway can keep a revocation list
keyed by grant id. It still wouldn't need to know who owns the sandbox.

## 13. Measured: intercepting into a Worker, not the Durable Object

Today interception forwards every request into the owning Durable Object
(`WorkerBridge.ts` → `__alchemyEgress`). A live spike compared that with a
handler in the Worker entrypoint (one standard-4 container, 100 MB per download):

```
in the Worker entrypoint           1 download: 133 MB/s   4: 274 MB/s   8: 269 MB/s
through the Durable Object         1 download:  47 MB/s   4:  90 MB/s   8:  88 MB/s
  … with the body as an Effect Stream          34 MB/s       81 MB/s       87 MB/s

Durable Object RPC p90 while 8 downloads run (idle ≈ 45 ms)
Worker entrypoint 74 ms · through the Durable Object 221 ms · Effect Stream 307 ms
```

The entrypoint never ran in the Durable Object's isolate. The upstream was
synthetic (speed.cloudflare.com rate-limits Workers), so the Durable Object's
CPU cost is an upper bound; the throughput gap is the robust result. The relay
in section 7 adds one service-binding hop to the gateway, which runs on the
caller's thread (no public network).

## 14. Bugs this fixes in what's built

```ts
// 1. ContainerClient.ts keeps the egress set in memory only:
coordinationFor(container).liveEgress = next; // a WeakMap: gone when the Durable Object is evicted
//    - interception is lost if the Durable Object restarts while the container runs (fails closed)
//    - a repeated start({ egress }) re-applies the original set, undoing setEgress
//    Fix: section 11 (stored decision, re-applied by the alarm).

// 2. start({ egress }) skips re-intercepting when the set looks unchanged (found by the spike).
//    Fix: always apply what's stored.

// 3. makeEgressHandle buffers request bodies. Fix: stream them (a large git push).
```

## 15. Every environment

```ts
// The gateway: any HTTP host
Cloudflare.Worker("Gateway", { main }, Egress.Gateway({ egress }));
AWS.Lambda.Function("Gateway", { main, url: true }, Egress.Gateway({ egress }));

// The sandbox hosts: none of them name a gateway
Cloudflare.Containers.Sandbox(Sandbox, { main, image, sizes: { small: "basic", large: "standard-4" } }, program);
AWS.MicroVM.Sandbox(Sandbox, { main, image, sizes: { small: "4 GB", large: "32 GB" } }, program);
AWS.ECS.Sandbox(Sandbox, { main, image, sizes: { small: { cpu: 1, memory: "4 GB" }, large: { cpu: 8, memory: "32 GB" } } }, program);
Fly.Sandbox(Sandbox, { main, image, sizes: { small: "shared-cpu-2x", large: "performance-8x" } }, program);
Local.Sandbox(Sandbox, { main }, program); // alchemy dev: the same proxy

// The Durable Object: the same code on every host
const gateway = yield* Egress.connect(Gateway);
yield* sandbox.start({ size: "large", gateway, egress: [model, repo.narrow({ issue })] });
```

## 16. Pull requests

```
1. #2251 (merged)  ctx.props and ctx.exports in the Effect DX
2. alchemy/Egress  Egress.Gateway, Egress.connect, Grant (WebCrypto), EgressRef + handlerFor
3. Cloudflare      AlchemyEgress relay entrypoint; route via service binding / URL; stored decision
                   + alarm renewal; bugs 1–3; drop the __alchemyEgress hop through the Durable Object
4. Hosts           harness servers yield { fetch }; Cloudflare.Containers.Sandbox(Sandbox, props, program)
                   replaces Sandbox.make; named sizes
5. AWS microVM     the bootstrap proxy; AWS.MicroVM.Sandbox
```

## 17. Open questions

1. **Sharing the gateway's key:** `connect` binds it into every Worker that grants for that gateway, so minting needs no call. The alternative keeps the key in the gateway alone and mints over RPC (`gateway.grant(...)` through the service binding), at one call per renewal. Worth it?
2. **Certificates in the proxy:** it signs X.509 leaf certificates per host, which Node can't do natively. `@peculiar/x509` (a dependency), hand-rolled DER, or a proxy written in Go?
3. **The control port** must be reachable by the Durable Object only (a security group or private networking). Over the public internet, the control secret is the only protection.
4. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, but it skips the rules for non-egress hosts. Closing it needs a firewall that only allows the gateway.
5. **A missed renewal:** if the Durable Object can't renew for a whole `ttl`, egress stops until it can. Fail closed like that, or let the proxy ask for a grant?
6. **Isolate placement on Cloudflare:** concurrent intercepted requests mostly shared one isolate (~270 MB/s). Enough for agents; worth re-measuring with a real upstream before relying on it for bulk transfer.
