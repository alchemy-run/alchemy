# Container egress

Give a container's programs authenticated access to APIs (GitHub, Anthropic,
any HTTP API) without the credentials ever entering the container. The
Durable Object that owns the container intercepts its outbound HTTP(S),
checks each request against a declared policy, adds the real credentials,
and forwards it.

## Goals

- **No secrets in the container.** The container sees placeholders
  (`GH_TOKEN=alchemy-egress`); real credentials live in the Worker's secrets.
- **Access control in code.** What a container may reach, and how, is
  declared on the egress: per repository and permission for GitHub, by host
  and path for other APIs. Deny by default.
- **Least privilege per session, from the first request.** A session's scope
  (e.g. one pull request) is fixed when the session starts, before its
  container boots. There is never a moment with more access than the scope.
- **Per container.** Each container class's egress is declared by the
  Durable Object that owns it, so different containers get different access.

## DX

```ts
// src/Sandbox.runtime.ts: the program inside the container. No credentials.
export default Sandbox.make(
  { main: import.meta.url, runtime: "node", dockerfile: Dockerfile.inline`FROM node:24-bookworm` },
  Effect.gen(function* () {
    const repo = yield* GitHub.MountRepository("alchemy-run/alchemy", {
      path: "/workspace/alchemy",
      access: "write",
      egress: true, // git over HTTPS through the Durable Object's GitHub egress
    });
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: repo.path });
    return { fetch: claude.fetch };
  }),
);
```

```ts
// src/Agent.ts: the Durable Object that owns one container per session.
export const Assignment = Schema.Union([
  Schema.Struct({ pullRequest: Schema.Number }),
  Schema.Struct({ issue: Schema.Number }),
]);

export const AgentRpcs = AI.SessionRpcs.scoped(Assignment);

export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AgentRpcs },
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // The ceiling: the most any session may be narrowed to.
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
    const model = yield* Anthropic.Egress(Sandbox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });

    const harness = Cloudflare.ContainerHarness(sandbox);
    const state = yield* Cloudflare.DurableObjectState;

    return harness.session({
      id: state.id.name ?? state.id.toString(),
      scope: Assignment,
      // Evaluated inside `start`, before the container boots.
      egress: (assignment) => [
        model,
        github.narrow({ repository: "alchemy-run/alchemy", ...assignment }),
      ],
    });
  }),
) {}
```

```ts
// Driving it (Worker, or any client of the Durable Object):
const agent = yield* agents.getByName("pr-42");
yield* agent.start({ scope: { pullRequest: 42 } }); // fixes the scope, then boots the container
yield* agent.prompt({ prompt: "Fix the failing test" });
```

## Concepts

### Egress (declaration)

`Cloudflare.Egress(Container, host, handler)` and the presets
(`GitHub.Egress`, `Anthropic.Egress`) are bindings yielded in the Durable
Object's construction phase. They take the container **class** (static: what
this container may ever reach) and return an `Egress` value.

Deploy half (`!__ALCHEMY_RUNTIME__`):

- Bind the credentials into the Worker hosting the Durable Object as
  `secret_text` (`Output.named`, like the GitHub webhook secret).
- Bind onto the container application's binding contract, from the Durable
  Object side (as `AI.LocalHarness` binds `devHost`):
  - `image`: an install-stage layer that, at container start, trusts the
    per-instance interception CA
    (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) in the system
    store, and sets `NODE_EXTRA_CA_CERTS`.
  - `env`: placeholders the CLIs need to consider themselves signed in
    (`GH_TOKEN`, `ANTHROPIC_API_KEY`), and preset tooling (`gh`, a git
    credential for `https://github.com` answering the placeholder).

Runtime half: register the egress (its key, hosts and policy) in the
container handle's egress registry.

### Selection

The handle's live egress set decides which interceptors are registered:

| Method | Effect |
|---|---|
| `start({ egress })` | Starts the container (if not running) with exactly this set |
| `setEgress(egresses)` | Replaces the live set on the running container |
| `addEgress(egress)` / `removeEgress(egress)` | Adds or removes one |

The live set is persisted in the Durable Object's storage and re-applied on
every start (the platform drops interception when the container restarts).
`start` without `egress` means no network.

### Narrowing

`egress.narrow(scope)` returns a smaller egress: the intersection of the
declaration and the scope. It can never widen, so it is safe to derive from
caller input. For GitHub:

| Scope | Allowed | Denied |
|---|---|---|
| `{ pullRequest: 42 }` | read the repo; read/comment/review #42; push to #42's head branch | other PRs and issues, other branches, merging (unless `merge: true`) |
| `{ issue: 17 }` | read the repo; read/comment #17; push to `agent/issue-17/**`; open a PR from it | other issues and PRs, other branches |

### Scoped sessions

`AI.SessionRpcs.scoped(Schema)` makes the session's `start` take a typed
`scope`. `ContainerHarness(sandbox).session({ id, scope, egress })`:

- `start({ scope })` computes `egress(scope)`, saves the scope, *then*
  starts the container with exactly that set. Restarting reads the saved
  scope. A different scope fails: a session's scope never changes.
- Every other operation before `start` fails with "session not started";
  nothing boots the container with a wider set.

## Request path

```text
container process ──HTTPS──▶ platform interception (per host, ports 80/443)
  ──▶ this Worker's default entrypoint, ctx.props = { egress: { namespace, id, key } }
  ──▶ Durable Object `id` (reserved RPC method) ──▶ the egress's handler
  ──▶ policy check (deny → 403 with an explanation) ──▶ add credentials ──▶ fetch upstream
  ◀── streamed response
```

- Cloudflare delivers intercepted traffic only to a Worker entrypoint or
  service binding, so interception registers
  `ctx.exports.default({ props })`; the Worker bridge claims requests whose
  props carry `egress` before the user's `fetch`.
- The Durable Object runs the handler: it holds the session's scope and can
  log every decision per session.

## GitHub

`GitHub.Egress(Container, options)`:

```ts
type GitHubEgressOptions = {
  repositories: ReadonlyArray<
    {
      repository: GitHub.Repository | `${string}/${string}`;
      push?: { branches: ReadonlyArray<string> };
    } & Partial<Record<GitHubPermission, "read" | "write">>
  >;
} & (
  | { token: Redacted<string> } // a PAT, or GitHub.ProfileToken
  | { app: { appId: string; privateKey: Redacted<string>; installationId: number } }
);
```

- Hosts: `api.github.com`, `uploads.github.com`, `github.com` (git smart
  HTTP), or the profile's GitHub Enterprise host.
- `GitHub.ProfileToken`: the token of the stack's GitHub auth profile
  (`gh auth token`, stored PAT, env), resolved at deploy. Explicit opt-in.
- Classification, deny by default:
  - REST: method + route → (repository, permission, read/write), from
    GitHub's fine-grained permission table.
  - GraphQL: queries read; mutations map to permissions; repository from
    variables or resolved node ids (cached in the Durable Object).
  - git: `git-upload-pack` → contents:read; `git-receive-pack` →
    contents:write, plus ref names from the push for `push.branches`.
- Denials answer `403` with `alchemy egress: <reason>`, so the agent can
  adjust.
- With an App, each mint is scoped to the declaration (GitHub enforces it);
  `push.branches` is always enforced by the Durable Object.

## Phases

1. **Spike** — a container with `interceptOutboundHttps` on a test host:
   the CA appears with runtime-only registration; requests reach the Worker
   entrypoint with props; deployed and local Docker.
2. **Core** — `Cloudflare.Egress`, the handle's egress set, the Worker and
   Durable Object routing, CA trust layer, `start({ egress })`.
3. **Presets** — `Anthropic.Egress`, `GitHub.Egress` (token/ProfileToken,
   repository permissions, branches, narrowing), `MountRepository({ egress })`.
4. **Sessions** — `AI.SessionRpcs.scoped`, `ContainerHarness(sandbox).session`,
   harness servers' `.fetch`.
5. **Example + tests** — the coding agent on a test repository: `gh`/git work
   with placeholders; denied requests get 403; scope fixed at start.

## Open

- `Cloudflare.Egress.Direct` (the platform's `enableInternet`, start-only,
  unproxied) for workloads that need non-HTTP ports.
- GitHub App minting (`app` option) after the PAT path.
- `alchemy dev` with `AI.LocalHarness` has no interception: egress
  credentials are injected into the local process env there.
