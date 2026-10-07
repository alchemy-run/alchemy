# solid-yield (vendored)

[solid-yield](https://github.com/devagrawal09/solid-yield) has no npm release
yet. These tarballs are `pnpm pack` outputs of `packages/yield` and
`packages/vite-plugin-yield`, built from upstream commit
`c797bb3996080c515d1e0469f0011a6e3f7770e2`. The `Website.SolidYield` test
fixture and example depend on them via `file:`.

To refresh:

```sh
git clone https://github.com/devagrawal09/solid-yield && cd solid-yield
pnpm install && pnpm --filter solid-yield run build
(cd packages/yield && pnpm pack --pack-destination <alchemy>/vendor/solid-yield)
(cd packages/vite-plugin-yield && pnpm pack --pack-destination <alchemy>/vendor/solid-yield)
```

Then `pnpm install --force` at the alchemy root. Delete this directory and
switch to npm specifiers once solid-yield is published.
