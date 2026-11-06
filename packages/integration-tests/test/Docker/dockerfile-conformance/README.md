# Dockerfile parser conformance

`DockerfileParser.conformance.test.ts` parses every `cases/<name>/Dockerfile` with `@alchemy.run/docker/DockerfileParser` and compares the result with `cases/<name>/expected.json`, which is BuildKit's reading of the same file.

`oracle/` writes the expectations by running BuildKit itself (`frontend/dockerfile/parser` and `frontend/dockerfile/instructions`, pinned in `oracle/go.mod`), applying Docker's word processing with no variable expanded. A file BuildKit rejects is `{ "ok": false }`, and the parser must reject it too.

Regenerate after adding a case or bumping BuildKit:

```sh
cd oracle && go run . ../cases
```

To add a case, create `cases/<name>/Dockerfile` and regenerate. Never edit `expected.json` or `cases.json` by hand.

The `buildkit-*` cases are copied from BuildKit's parser corpus (`frontend/dockerfile/parser/testfiles` and `testfiles-negative`, Copyright The BuildKit Authors, Apache License 2.0). Six cases with no `FROM` have `FROM scratch` prepended, and `*-processable` drops the one line Docker cannot process from `buildkit-env` and `buildkit-escapes`.
