# Verification

Every API name, prop, environment variable and capability claim in the docs is
checked against the source before it ships. Most review corrections on provider
docs were confident claims that turned out wrong.

## Check snippets against the package

For each snippet, open the resource or binding it uses in
`packages/<provider>/src/` and confirm:

- **The export path and casing**: `AWS.ECS.Service(...)` is a function,
  not a class. `Cloudflare.ApiToken.AccountApiToken`, not `Cloudflare.AccountApiToken`.
- **Prop names**: `memorySize`, not `memory`. `migrations`, not `migrationsDir`.
  `path`, not `sourcePath`. `pointInTimeRecoveryEnabled`.
- **Prop types**: a `value?: string` prop takes `Config.String(...)`, not
  `Config.Redacted(...)`.
- **Attribute names**: `api.functionUrl`, `api.uri` on GCP, `ingest.token`.
- **The JSDoc examples** on the export. They are tested patterns. Prefer their
  shapes over inventing your own.
- **Required Layers**: a binding's client Layer is provided on the runtime
  (`Effect.provide(AWS.SQS.SendMessageHttp)`).
- **Resolved values**: an event source or consumer that needs a resolved
  resource yields it first (`const files = yield* Files`). A prop built from an
  output that isn't known until deploy uses `Output.map` (or
  `` Output.interpolate`…` ``).
- **Tested code first**: the `examples/<provider>-*` projects and the JSDoc
  examples. When a page needs code that no example has, add it to an example
  and deploy it first.
- **State the grant.** A binding section says which permission or role it
  grants, and that the grant covers only the bound resource.

## Check claims against the platform and the provider

- **Credentials and CI variables** come from the provider's `AuthProvider.ts` or
  `Contributions` module and its setup page, never memory.
- **Lifecycle behavior** comes from the provider's `delete`/`reconcile`. Destroying
  an `Axiom.ApiToken` revokes it; destroying a `GitHub.PersonalAccessToken`
  only forgets it. Read the code before writing either sentence.
- **Runtime requirements** come from code: the Node minimum is in
  `packages/alchemy/bin/cli.js`.
- **Don't promise what Alchemy doesn't do.** Examples that were wrong:
  - "Alchemy backs up PlanetScale". It only restores from a `backupId`.
  - "D1 sessions" support, which is available only through the `raw` client.
  - "Server-side apply keeps an autoscaler's replicas". It overwrites them.
  - "Custom domains switch with no downtime".

  When the source doesn't support a claim, soften it to what's true, or cut it.
- **Platform facts** (city counts, feature availability) come from the
  platform's own current pages. Cite the source to the user. When you can't
  verify one, leave it out and say so.

## Check the built site

```sh
cd website && pnpm run build
.agents/skills/write-docs/scripts/check-links.sh website/src/content/docs/<provider>/<page>.mdx …
.agents/skills/write-docs/scripts/screenshot.sh /<provider>/<page>/ /tmp/<page>.png
```

Read every screenshot of a page with a diagram. Before calling a page done,
search the provider's pages for stale phrasings you've replaced elsewhere:
package-centric openings, "SSO (recommended)", "Bun or Node", "Node.js 22+",
"default runtime".
