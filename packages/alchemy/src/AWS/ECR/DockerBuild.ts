import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as crypto from "node:crypto";

export interface DockerBuildSource {
  context: string;
  dockerfile: string;
  platform: string;
  buildArgs?: Record<string, string>;
}

export type DockerBuildHashMode = "all" | "effective";

interface DockerIgnoreRule {
  ignored: boolean;
  expression: RegExp;
}

interface DockerIgnore {
  content: string;
  path: string;
  rules: ReadonlyArray<DockerIgnoreRule>;
}

const normalizeRelativePath = (value: string) =>
  value.replaceAll("\\", "/").replace(/^\.\/+/, "");

const escapeRegExp = (value: string) =>
  value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

/**
 * Compile Docker's ordered ignore-pattern form into a path matcher.
 *
 * Matching is rooted at the context. Descendants of a matched directory are
 * handled by checking each path's parents in {@link isDockerIgnored}.
 */
const compileDockerIgnoreRule = (raw: string): DockerIgnoreRule | undefined => {
  if (raw.startsWith("#")) {
    return undefined;
  }

  let pattern = raw.trim();
  if (pattern.length === 0 || pattern === ".") {
    return undefined;
  }

  let ignored = true;
  if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("!")) {
    ignored = false;
    pattern = pattern.slice(1).trim();
  }

  pattern = normalizeRelativePath(pattern)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (pattern.length === 0 || pattern === ".") {
    return undefined;
  }

  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index++;
        }
        if (pattern[index + 1] === "/") {
          index++;
          body += "(?:.*/)?";
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      body += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        const content = pattern.slice(index + 1, end);
        const negated = content.startsWith("!") || content.startsWith("^");
        const members = negated ? content.slice(1) : content;
        body += `[${negated ? "^" : ""}${members.replaceAll("\\", "\\\\")}]`;
        index = end;
        continue;
      }
    }
    body += escapeRegExp(char);
  }

  return {
    ignored,
    expression: new RegExp(`^${body}$`),
  };
};

const isDockerIgnored = (
  relativePath: string,
  rules: ReadonlyArray<DockerIgnoreRule>,
) => {
  const segments = normalizeRelativePath(relativePath).split("/");
  const candidates = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  let ignored = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.expression.test(candidate))) {
      ignored = rule.ignored;
    }
  }
  return ignored;
};

/**
 * Resolve and validate a Docker build context and Dockerfile.
 *
 * Dockerfile paths are relative to the build context unless absolute.
 */
export const resolveDockerBuildPaths = Effect.fn(function* (
  source: Pick<DockerBuildSource, "context" | "dockerfile">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(source.context);
  const dockerfile = path.isAbsolute(source.dockerfile)
    ? source.dockerfile
    : path.resolve(context, source.dockerfile);

  if (!(yield* fs.exists(context))) {
    return yield* Effect.fail(
      new Error(`Docker build context does not exist: ${context}`),
    );
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.fail(
      new Error(`Dockerfile does not exist: ${dockerfile}`),
    );
  }

  return { context, dockerfile };
});

const resolveDockerIgnore = Effect.fn(function* ({
  context,
  dockerfile,
}: {
  context: string;
  dockerfile: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dockerfileIgnore = `${dockerfile}.dockerignore`;
  const contextIgnore = path.join(context, ".dockerignore");
  const ignoreFile = (yield* fs.exists(dockerfileIgnore))
    ? dockerfileIgnore
    : (yield* fs.exists(contextIgnore))
      ? contextIgnore
      : undefined;

  if (ignoreFile === undefined) {
    return undefined;
  }

  const content = yield* fs.readFileString(ignoreFile);
  const relativePath = normalizeRelativePath(
    path.relative(context, ignoreFile),
  );
  return {
    content,
    path: relativePath.startsWith("../")
      ? path.basename(ignoreFile)
      : relativePath,
    rules: content.split(/\r?\n/).flatMap((line) => {
      const rule = compileDockerIgnoreRule(line);
      return rule === undefined ? [] : [rule];
    }),
  } satisfies DockerIgnore;
});

/**
 * Hash a Docker build context together with the Dockerfile, platform, and
 * build arguments. In `effective` mode, the selected `.dockerignore` is
 * applied exactly once before files are hashed. Absolute paths do not
 * participate.
 */
export const hashDockerBuildInputs = Effect.fn(function* (
  source: DockerBuildSource,
  mode: DockerBuildHashMode,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { context, dockerfile } = yield* resolveDockerBuildPaths(source);
  const dockerignore =
    mode === "effective"
      ? yield* resolveDockerIgnore({ context, dockerfile })
      : undefined;
  const hasher = yield* Effect.sync(() => crypto.createHash("sha256"));

  yield* Effect.sync(() =>
    hasher.update(
      JSON.stringify({
        platform: source.platform,
        buildArgs: Object.entries(source.buildArgs ?? {}).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
        dockerignore:
          dockerignore === undefined
            ? undefined
            : {
                content: dockerignore.content,
                path: dockerignore.path,
              },
      }),
    ),
  );

  const dockerfileContent = yield* fs.readFile(dockerfile);
  yield* Effect.sync(() => {
    hasher.update("Dockerfile\0");
    hasher.update(dockerfileContent);
  });

  const entries = yield* fs.readDirectory(context, { recursive: true });
  const files = yield* Effect.forEach(
    entries.sort(),
    Effect.fn(function* (entry) {
      const normalizedEntry = normalizeRelativePath(entry);
      if (
        dockerignore !== undefined &&
        (normalizedEntry === dockerignore.path ||
          isDockerIgnored(normalizedEntry, dockerignore.rules))
      ) {
        return undefined;
      }
      const fullPath = path.join(context, entry);
      const info = yield* fs.stat(fullPath);
      if (info.type !== "File") {
        return undefined;
      }
      return {
        entry: mode === "effective" ? normalizedEntry : entry,
        content: yield* fs.readFile(fullPath),
      };
    }),
  );

  yield* Effect.sync(() => {
    for (const file of files) {
      if (file === undefined) {
        continue;
      }
      hasher.update(`${file.entry}\0`);
      hasher.update(file.content);
    }
  });

  return (yield* Effect.sync(() => hasher.digest("hex"))).slice(0, 32);
});
