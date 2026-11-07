# Dockerfile parser conformance

`DockerfileParser.conformance.test.ts` parses every `cases/<name>/Dockerfile` with `@alchemy.run/docker/DockerfileParser` and compares the result with `cases/<name>/expected.json`, which is BuildKit's reading of the same file.

`oracle/` writes the expectations by running BuildKit itself (`frontend/dockerfile/parser` and `frontend/dockerfile/instructions`, pinned in `oracle/go.mod`), applying Docker's word processing with no variable expanded. A file BuildKit rejects is `{ "ok": false }`, and the parser must reject it too.

Regenerate after adding a case or bumping BuildKit:

```sh
cd oracle && go run . ../cases
```

`ShellWord.conformance.test.ts` does the same for Docker's word processing: `words/inputs.json` holds BuildKit's lexer tables (`shell/envVarTest`, `shell/wordsTest`) plus forms they leave out, and the oracle writes each input's result in every lexer mode the parser uses to `words/expected.json`.

The oracle also runs what `docker build` does before running an instruction (`Expand`, with no variable set), so a value Docker rejects at build time, such as a bad `RUN --mount`, is a rejected case too.

To add a case, create `cases/<name>/Dockerfile` and regenerate. Never edit `expected.json` or `cases.json` by hand.

The `buildkit-*` cases are copied from BuildKit's parser corpus (`frontend/dockerfile/parser/testfiles` and `testfiles-negative`, Copyright The BuildKit Authors, Apache License 2.0). Six cases with no `FROM` have `FROM scratch` prepended, and `*-processable` drops the one line Docker cannot process from `buildkit-env` and `buildkit-escapes`.

### Coverage

The corpus is complete when it reaches every line of BuildKit's parser, lexer and instruction checks that a Dockerfile can reach. Measure it with:

```sh
cd oracle && go test -count=1 -coverpkg=github.com/moby/buildkit/frontend/dockerfile/parser,github.com/moby/buildkit/frontend/dockerfile/shell,github.com/moby/buildkit/frontend/dockerfile/instructions -coverprofile=cover.out . && go tool cover -html=cover.out
```

An uncovered branch is a missing case. Out of scope: frontend syntax detection, AST dumps, the linter, `--unset` and `--reset` (off in BuildKit builds), and expanding variables that have values (Alchemy leaves variables to the builder).
