# Egress (design)

A sandbox holds no credentials. Its requests to egress hosts (GitHub,
Anthropic, …) are handled outside it, where the rules run and the real token
is added. Every other host goes straight out.

The handlers always run in a stateless Worker entrypoint, never in a Durable
Object. The Durable Object that owns the sandbox only decides *which* egresses
the sandbox has. There are two ways in:

- **Cloudflare Container:** the runtime intercepts the container's traffic
  into the Worker's own `AlchemyEgress` entrypoint, with the sandbox's
  egresses in the stub's props. The container can't read or forge props, so
  there's no grant, TTL or renewal.
- **Anywhere else** (AWS microVM, ECS, Fly, a local process): a proxy in the
  sandbox sends egress hosts to a gateway over the public internet, with a
  signed, short-lived grant. The gateway is a `fetch` you route to.

```
Cloudflare Container                              Cloudflare
  git push ─▶ interceptOutboundHttps ───────────▶ Worker: AlchemyEgress entrypoint
                (props: { egress: [refs] })         handler(ref) → add token → github.com
                                                  Durable Object: sets props, never sees bytes

microVM / ECS / Fly                               Cloudflare (or any HTTP host)
  git push ─▶ proxy :3128 ─── HTTPS + grant ────▶ gateway.fetch
              routes the grant's hosts              verify grant → handler(ref) → github.com
  control :3129 ◀──── fresh grant before expiry ── Durable Object
```

## 1. Declare the egresses

```ts
// src/egress.ts
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import { Sandbox } from "./Sandbox.ts";

// Module-level declarations: every isolate of the Worker that imports them can run their handlers.
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

## 2. Decide per session, in the Durable Object

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
            size: "large", // a name declared on Sandbox; each host maps it (section 3)
            egress: [model, repo.narrow({ repository: "alchemy-run/alchemy", issue })],
            // Grant lifetime off Cloudflare (default 5 minutes). Ignored on a Cloudflare Container.
            ttl: "5 minutes",
          }),
        // Applies at once, on live connections too.
        modelOnly: () => sandbox.setEgress([model]),
        settle: () => sandbox.stop(),
      };
    });
  }),
) {}
```

```ts
// src/worker.ts — hosts Agent; nothing about egress
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

## 3. Declare the sandbox and its hosts

```ts
// src/Sandbox.ts — the shape the Durable Object uses: start, exec, setEgress, stop
import * as AI from "alchemy/AI";

// The size names are part of the declaration: they type start({ size }).
export class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large" }>()("Sandbox") {}
```

Sizes are named, not measured, because hosts size differently. A Cloudflare
Container picks its instance type at `start()`. A Lambda microVM's memory is
fixed on its image (`CreateMicrovmImage.resources`; `RunMicrovm` has no size),
so each size is its own image, built at deploy, and `start()` picks the image.
Each host maps every declared name; a missing or extra name doesn't compile:

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts
export const Sandbox = <S extends AI.Sandbox.Any>(
  sandbox: S,
  props: { sizes: Record<AI.Sandbox.Size<S>, `${number} GB`>; /* main, image, gateway, … */ },
  program: Effect.Effect<SandboxShape, never, SandboxServices>,
) => ...

AWS.MicroVM.Sandbox(Sandbox, { sizes: { small: "4 GB" } }, program);
// ✗ Property 'large' is missing in type '{ small: "4 GB" }'
```

There is no `Sandbox.make`. A host constructor takes the declaration, the
host's props and the program, and the program provides its own layers,
because only code written for a host knows what that host offers:

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
import Gateway from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export default AWS.MicroVM.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    // One microVM image per name, built at deploy; start() picks the image.
    sizes: { small: "4 GB", large: "32 GB" },
    // Where the proxy sends egress traffic: anything with a `url`, or a URL string.
    // Routed inside your own Worker instead: `gateway: Api, gatewayPath: "/egress"`.
    gateway: Gateway,
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, AWS.MicroVM.Metadata)),
  ),
);
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

## 4. Pick the platform

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
    const api = yield* Api;
    return { api: api.url.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
```

## 5. The gateway, off Cloudflare only

A Cloudflare Container needs no gateway. Off Cloudflare, the proxy needs a
public URL, so the gateway is a `fetch` you route to. `Egress.Gateway` is a
whole Worker (or Lambda) implementation by itself:

```ts
// src/gateway.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Egress from "alchemy/Egress";
import { Model, Repo } from "./egress.ts";

// Binds the egresses' secrets and the root key that verifies grants into this Worker.
export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

```ts
// src/gateway.ts — the same on a Lambda with a function URL
export default class Gateway extends AWS.Lambda.Function<Gateway>()(
  "Gateway",
  { main: import.meta.url, url: true },
  Egress.Gateway({ egress: [Model, Repo] }),
) {}
```

```ts
// or inside your own Worker, routed by hand (sandbox: `gateway: Api, gatewayPath: "/egress"`)
const gateway = yield* Egress.Gateway({ egress: [Model, Repo] });
return {
  fetch: Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (new URL(request.url, "http://x").pathname === "/egress") return yield* gateway.fetch;
    // ...
  }),
};
```

If the Durable Object grants an egress the gateway doesn't serve, the gateway
refuses it (`github.com is not granted`): it fails closed. The type system
can't tie the two together, because the gateway is chosen in the Layer.

## 6. Egresses are data

A handler runs in a different isolate from the Durable Object that granted
it, so an egress travels as a reference, and the handler is rebuilt from it:

```ts
// alchemy internal: Egress/Egress.ts
export interface EgressRef {
  readonly egress: string; // the declaration's key: "Repo"
  readonly scope?: unknown; // what narrow() was given: { repository, issue }
}

// Filled when the declaring module loads; every isolate of the script imports it.
const declarations = new Map<string, EgressDeclaration>();

/** Rebuild the handler for a ref, wherever it runs: rules from the declaration, secret from env. */
export const handlerFor = (ref: EgressRef) =>
  Effect.gen(function* () {
    const declaration = declarations.get(ref.egress);
    if (!declaration) return yield* new EgressNotServed({ egress: ref.egress });
    return yield* declaration.handler(ref.scope); // reads its token from WorkerEnvironment
  });
```

Declaring an egress binds its secret into the env of the Worker that hosts the
Durable Object. On Cloudflare that is the same script as the `AlchemyEgress`
entrypoint, so the handler has its token with nothing else declared.

## 7. Cloudflare: intercept into the Worker, not the Durable Object

Today the runtime intercepts into the Worker, which forwards every request to
the owning Durable Object (`WorkerBridge.ts` → `__alchemyEgress`). Instead,
the Durable Object puts the sandbox's refs in the stub's props, and the
Worker runs the handler itself:

```ts
// alchemy internal: Cloudflare/Containers/ContainerClient.ts — in the owning Durable Object
const applyEgress = (refs: ReadonlyArray<EgressRef>) =>
  Effect.gen(function* () {
    const ctx = yield* Cloudflare.DurableObjectState;
    for (const [host, ref] of hostsOf(refs)) {
      // #2251: a stub to this script's own entrypoint, carrying props the container can't see
      const egress = yield* ctx.exports.AlchemyEgress({ props: { egress: ref } });
      yield* container.interceptOutboundHttps(host, egress);
    }
    for (const host of removedHosts) {
      yield* container.interceptOutboundHttps(host, yield* ctx.exports.AlchemyEgress({ props: { deny: true } }));
    }
  });
```

```ts
// alchemy internal: the generated Worker entry exports AlchemyEgress next to `default`
export class AlchemyEgress extends WorkerEntrypoint {
  fetch(request: Request) {
    const { egress, deny } = this.ctx.props;
    if (deny) return new Response("alchemy egress: this host is not allowed\n", { status: 403 });
    return run(handlerFor(egress).pipe(Effect.flatMap((handle) => handle(request))));
  }
}
```

The user's `fetch` is never involved: interception targets a dedicated
entrypoint, and the container can't reach it any other way. Calling
`interceptOutboundHttps` again with new props replaces them, even on open
connections, so `setEgress` and `stop` apply at once.

### Measured (live spike, one standard-4 container, 100 MB per download)

```
inline (handler in the Worker)     1 download: 133 MB/s   4: 274 MB/s   8: 269 MB/s
through the Durable Object         1 download:  47 MB/s   4:  90 MB/s   8:  88 MB/s
  … with the body as an Effect Stream          34 MB/s       81 MB/s       87 MB/s

Durable Object RPC p90 while 8 downloads run (idle ≈ 45 ms)
inline 74 ms · through the Durable Object 221 ms · Effect Stream 307 ms
```

The inline handler never ran in the Durable Object's isolate; concurrent
intercepted requests mostly shared one other isolate, on the container's
machine. The upstream was synthetic (speed.cloudflare.com rate-limits
Workers), so the Durable Object's CPU cost is an upper bound; the throughput
gap is the robust result.

## 8. Off Cloudflare: proxy and grants

### What the image gets (deploy time)

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

The image lists no hosts. Which hosts go to the gateway depends on the
session and changes mid-session, so it comes from the grant.

### What the Durable Object's Worker gets (deploy time)

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts
const worker = yield* Cloudflare.Worker; // hosts the Durable Object

// Signs grants here; Egress.Gateway yields the same declaration to verify them.
const rootKey = yield* Egress.RootKey; // Random("EgressRootKey", { bytes: 32 })
yield* worker.bind`EgressRootKey`({ env: { ALCHEMY_EGRESS_ROOT_KEY: rootKey.value } });

const gatewayUrl =
  typeof options.gateway === "string"
    ? options.gateway
    : Output.interpolate`${(yield* options.gateway).url}${options.gatewayPath ?? "/"}`;
yield* worker.bind`EgressGateway`({ env: { ALCHEMY_EGRESS_GATEWAY: gatewayUrl } });

const launcher = yield* AWS.IAM.Role("SandboxLauncher", {
  /* trust: this Worker; permissions: run/stop microVMs from this image */
});
yield* worker.bind`SandboxLauncher`({ env: { AWS_ROLE_ARN: launcher.roleArn } });
```

### The Durable Object starts the sandbox and keeps its grant fresh (run time)

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — in the owning Durable Object
interface EgressState {
  readonly ttl: Duration.Duration;
  readonly egress: ReadonlyArray<EgressRef>;
}
const load = state.storage.get<EgressState>("egress").pipe(
  Effect.map((s) => s ?? { ttl: Duration.minutes(5), egress: [] }),
);
const save = (next: EgressState) => state.storage.put("egress", next);

/** Renew at 40% of the TTL: one push can fail and the next still lands before expiry. */
const renewIn = (ttl: Duration.Duration) => Duration.toMillis(ttl) * 0.4;

const mintGrant = ({ ttl, egress }: EgressState) =>
  Grant.mint(rootKey, crypto.randomUUID(), [
    { expires: Date.now() + Duration.toMillis(ttl) },
    ...egress.map((ref) => ({ egress: ref.egress, scope: ref.scope })),
    { hosts: egress.flatMap(hostsOf) },
  ]);

/** Hand the proxy a new grant over its control port. */
const pushGrant = (grant: Grant | undefined) =>
  HttpClient.post(`${machineUrl(3129)}/grant`, {
    body: grant ? Grant.encode(grant) : "",
    headers: { authorization: `Bearer ${controlSecret}` },
  });

start: ({ size, egress: given, ttl }) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const current: EgressState = {
      ttl: ttl !== undefined ? Duration.decode(ttl) : stored.ttl,
      egress: given !== undefined ? given.map(Egress.toRef) : stored.egress,
    };
    yield* save(current);
    if (yield* running) return yield* pushGrant(yield* mintGrant(current)); // already up: re-sync
    const controlSecret = crypto.randomUUID();
    yield* state.storage.put("controlSecret", controlSecret);
    yield* microvms.run({
      imageIdentifier: imageFor[size], // one image per declared size, built at deploy
      env: {
        ...imageEnv, // GH_TOKEN=alchemy-egress, ALCHEMY_EGRESS_PROXY=1
        ALCHEMY_EGRESS_GATEWAY: env.ALCHEMY_EGRESS_GATEWAY,
        ALCHEMY_EGRESS_GRANT: Grant.encode(yield* mintGrant(current)),
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

alarm: () =>
  Effect.gen(function* () {
    if (!(yield* running)) return;
    const current = yield* load; // from storage: correct after an eviction
    yield* pushGrant(yield* mintGrant(current));
    yield* state.storage.setAlarm(Date.now() + renewIn(current.ttl));
  }),

setEgress: (egress, options) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const current: EgressState = {
      ttl: options?.ttl !== undefined ? Duration.decode(options.ttl) : stored.ttl,
      egress: egress.map(Egress.toRef),
    };
    yield* save(current); // stored first: a crash before the push converges on the next alarm
    yield* pushGrant(yield* mintGrant(current));
    yield* state.storage.setAlarm(Date.now() + renewIn(current.ttl));
  }),

stop: () =>
  pushGrant(undefined).pipe( // routes nothing from now on
    Effect.andThen(microvms.stop(machineId)),
    Effect.andThen(state.storage.deleteAlarm()),
  ),
```

### The proxy (the image's bootstrap, before `main`)

```ts
// alchemy internal: Runtime/Bootstrap/index.ts
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
  const routed = () => new Set(grant ? Grant.hosts(Grant.decodeUnverified(grant)) : []);
  const ca = await makeLocalCa("/etc/cloudflare/certs/cloudflare-containers-ca.crt");

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

  // :3129 — only the Durable Object (holding controlSecret) can swap the grant
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

### The gateway's `fetch` (stateless)

```ts
// alchemy internal: Egress/Gateway.ts
export const Gateway = (options: { readonly egress: ReadonlyArray<EgressDeclaration> }) =>
  Effect.gen(function* () {
    const rootKey = yield* Egress.RootKey; // binds the key into whatever yields this
    for (const declaration of options.egress) yield* declaration; // binds each secret here
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const grant = yield* Grant.decode(request.headers.authorization);
        if (!(yield* Grant.verify(rootKey, grant))) return HttpServerResponse.text("bad grant", { status: 401 });
        const target = new URL(request.headers["x-alchemy-target"]!);
        const ref = Grant.allowed(grant, target.hostname, Date.now()); // expiry + hosts + egress caveats
        if (!ref) return HttpServerResponse.text(`${target.hostname} is not granted`, { status: 403 });
        // The same handler as on Cloudflare: rules, refusals in git's / gh's format, token, streamed body.
        const handle = yield* handlerFor(ref);
        return yield* handle(toUpstreamRequest(request, target));
      }),
    };
  });
```

### Grants (WebCrypto, no dependency)

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
tokens stay in the gateway's host.

## 9. Where egress state lives

```ts
// Stateless, fixed at deploy time: declarations, rules, tokens (the handler host's env).
export const Repo = GitHub.Egress(Sandbox, { token: GitHub.ProfileToken, repositories });

// Stateful, in the owning Durable Object's storage: the egress set (and ttl), as data.
yield* state.storage.get("egress");
// { ttl: "5 minutes", egress: [{ egress: "Model" }, { egress: "Repo", scope: { repository, issue: 42 } }] }

// Applied copies of it:
//   Cloudflare: the intercept props (the runtime holds them; the container can't see them)
//   elsewhere:  a signed grant in the proxy's memory, expiring after `ttl`
```

```ts
yield* sandbox.start({ egress: [model, repo.narrow({ repository, issue })], ttl: "5 minutes" }); // stores, applies
yield* sandbox.setEgress([model], { ttl: "1 hour" }); // stores, applies; ttl kept if omitted
yield* sandbox.start(); // no `egress`: re-applies what's stored (keeps the setEgress above)
yield* sandbox.stop(); // stops; the stored set stays for the next start()
```

Every failure converges from storage:

```ts
// The Durable Object is evicted while the sandbox runs:
//   Cloudflare: constructing the Durable Object re-applies the stored refs as intercept props.
//   elsewhere:  the next alarm mints from storage.
// The proxy restarts: its startup grant may have expired; the next alarm (≤40% of ttl) pushes a fresh one.
// A crash between storing and applying: the next construction / alarm applies what's stored.
```

## 10. Revocation

```ts
// The sandbox loses access at once, on every platform:
yield* sandbox.setEgress([model]); // Cloudflare: new props on live connections; elsewhere: new grant
yield* sandbox.stop();

// Off Cloudflare only: a grant copied out of the sandbox works until it expires, at most `ttl`.
```

A shorter `ttl` narrows that window. If it's ever not enough for writes, the
gateway could keep a revocation list keyed by grant id, still without knowing
who owns the sandbox.

## 11. Bugs this fixes in what's built

```ts
// 1. ContainerClient.ts keeps the egress set in memory only:
coordinationFor(container).liveEgress = next; // a WeakMap: gone when the Durable Object is evicted
//    - interception is lost if the Durable Object restarts while the container runs (fails closed)
//    - a repeated start({ egress }) re-applies the original set, undoing setEgress
//    Fix: section 9 (stored refs, re-applied on construction).

// 2. start({ egress }) skips re-intercepting when the set looks unchanged (found by the spike).
//    Fix: compare against the stored refs, and always re-apply on construction.

// 3. makeEgressHandle buffers request bodies. Fix: stream them (a large git push).
```

## 12. Every environment

```ts
// Cloudflare Container: interception into the Worker's AlchemyEgress entrypoint; size → instance type at start
Cloudflare.Containers.Sandbox(Sandbox, { main, image, sizes: { small: "basic", large: "standard-4" } }, program);

// AWS microVM: proxy + grants + gateway; size → one image per name
AWS.MicroVM.Sandbox(Sandbox, { main, image, sizes: { small: "4 GB", large: "32 GB" }, gateway }, program);

// ECS / Fly / Kubernetes: the same proxy and gateway; size → that platform's task / machine size at start
AWS.ECS.Sandbox(Sandbox, { main, image, sizes: { small: { cpu: 1, memory: "4 GB" }, large: { cpu: 8, memory: "32 GB" } }, gateway }, program);
Fly.Sandbox(Sandbox, { main, image, sizes: { small: "shared-cpu-2x", large: "performance-8x" }, gateway }, program);

// Every host: the Durable Object's code is the same
yield* sandbox.start({ size: "large", egress });

// A process on your machine under alchemy dev: the same proxy; the gateway runs locally
Local.Sandbox(Sandbox, { main, gateway }, program);
```

## 13. Pull requests

```
1. #2251 (merged)  ctx.props and ctx.exports in the Effect DX
2. Cloudflare      AlchemyEgress entrypoint; handlers from EgressRef props; stored refs;
                   bugs 1–3; drop the __alchemyEgress hop through the Durable Object
3. Harness servers yield { fetch }; Cloudflare.Containers.Sandbox(Sandbox, props, program)
                   replaces Sandbox.make
4. alchemy/Egress  Egress.Gateway, Egress.RootKey, Grant (WebCrypto), the bootstrap proxy
5. AWS microVM     AWS.MicroVM.Sandbox host constructor on top of 4
```

## 14. Open questions

1. **Certificates in the proxy:** it signs X.509 leaf certificates per host, which Node can't do natively. `@peculiar/x509` (a dependency), hand-rolled DER, or a proxy written in Go?
2. **The control port** must be reachable by the Durable Object only (a security group or private networking). Over the public internet, the control secret is the only protection.
3. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, but it skips the rules for non-egress hosts. Closing it needs a firewall that only allows the gateway.
4. **A missed renewal:** if the Durable Object can't reach the control port for a whole `ttl`, egress stops until the next push. Fail closed like that, or let the proxy ask for a grant?
5. **Isolate placement on Cloudflare:** concurrent intercepted requests mostly shared one isolate (~270 MB/s). Enough for agents; worth re-measuring with a real upstream before relying on it for bulk transfer.
