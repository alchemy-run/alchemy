# CLI launcher coverage

`launcher.test.ts` is the fast regression matrix for production JSX. It uses an install-shaped fixture and the real progress renderer, covering inherited `NODE_ENV` and caller JSX configurations. `exitCodes.test.ts` covers command exit behavior. Both run in the Check workflow.

`package.test.ts` is the external-install canary. It requires an actual packed `.tgz`; it never links the checkout into the temporary project or substitutes the CLI entrypoint. Each package manager installs the tarball and registry dependencies into its own OS temporary directory.

The canary covers:

- npm, pnpm, and Bun installations.
- Direct Node and Bun execution, `bun --bun alchemy`, and `bun x --bun` (the `bunx` equivalent).
- npm scripts, `npm exec`, and `npx`; pnpm scripts, `pnpm exec`, and `pnpm alchemy`; Bun scripts, `bun run --bun`, and `bun alchemy`.
- Unset and development `NODE_ENV`, plus caller `react-jsxdev` and Solid-style `preserve` configurations.
- Real noninteractive progress, local-state deploy/destroy, and nonzero exit propagation.
- Production environment, expected runtime, unchanged arguments and working directory, and resolved CLI/package paths inside the temporary install.

Each installer and CLI child receives a minimal environment and a fresh home directory with empty npm configuration. Cloud/registry credentials, user profiles, runtime hooks, module search paths, and checkout executable paths are not inherited. The deployed fixture also asserts that no credential environment variables are present. The pnpm fixture explicitly approves workerd's install script. The Bun install uses `--minimum-release-age=0` so freshly built releases can be exercised without changing global package-manager settings. Temporary projects, homes, and local state are removed when the test scope closes. No cloud or registry credentials are needed.

## Run locally

Build and pack first, then pass the tarball's absolute path:

```sh
pnpm build:pkg
packed=$(mktemp -d)
pnpm --dir packages/alchemy pack --pack-destination "$packed"
export ALCHEMY_CLI_PACKAGE=$(find "$packed" -maxdepth 1 -name 'alchemy-*.tgz')

for manager in npm pnpm bun; do
  ALCHEMY_CLI_PACKAGE_MANAGER="$manager" timeout 240 pnpm test test/Cli/package.test.ts --retry 0 --sequential
done
```

`ALCHEMY_CLI_PACKAGE_MANAGER` selects one installer. Omitting it runs all three sequentially. Without `ALCHEMY_CLI_PACKAGE`, the canary is skipped so ordinary unit runs do not install packages or require built artifacts.

## CI artifact

The Package Preview workflow runs the same canary against `.pkg/alchemy.tgz` after publishing its dependency tarballs. That file is the exact packed artifact produced by the job, with references to its packed workspace dependencies rewritten to the same commit's preview tarballs. The canary does not install a release tag, a workspace link, or the source directory.

A local `pnpm pack` instead references published versions of workspace dependencies, so those versions must already exist in the registry.
