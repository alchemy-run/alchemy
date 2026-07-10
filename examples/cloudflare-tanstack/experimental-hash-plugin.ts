import { Ignore } from "@alchemy.run/node-utils/ignore";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const hashFile = async (path: string) => {
  const content = await fsp.readFile(path);
  return crypto.createHash("sha256").update(content).digest("hex");
};

const memoize = <T extends (...args: Array<any>) => Promise<any>>(fn: T): T => {
  const cache = new Map<string, Promise<any>>();
  return (async (...args: Parameters<T>) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as T;
};

export const findUp = memoize(
  async (
    root: string,
    filenames: Array<string>,
  ): Promise<string | undefined> => {
    const results = await Promise.all(
      filenames.map(async (filename) => {
        const filePath = path.join(root, filename);
        if (
          await fsp
            .stat(filePath)
            .then(() => true)
            .catch(() => false)
        ) {
          return filePath;
        }
      }),
    );
    const file = results.find((result) => result !== undefined);
    if (file) {
      return file;
    }
    const parent = path.dirname(root);
    if (parent !== root) {
      return await findUp(parent, filenames);
    }
    return undefined;
  },
);

interface Meta {
  root: string;
  dir: string;
  ignore: Ignore;
}

const makeParent = async (dir: string): Promise<Meta> => {
  const git = await findUp(dir, [".git"]);
  const root = git ? path.dirname(git) : dir;
  const ignore = await buildRootIgnore(root, dir);
  return {
    root,
    dir,
    ignore,
  };
};

const makeChildMeta = async (dir: string, parent: Meta): Promise<Meta> => {
  const ignoreFile = await readIgnore(path.join(dir, ".gitignore"));
  if (!ignoreFile) return parent;
  return {
    root: parent.root,
    dir: parent.dir,
    ignore: new Ignore().add(parent.ignore).add(ignoreFile),
  };
};

const walk = async (
  dir: string,
  metaPromise: Promise<Meta>,
): Promise<Map<string, string>> => {
  const [files, meta] = await Promise.all([fsp.readdir(dir), metaPromise]);
  const hashes = new Map<string, string>();
  await Promise.all(
    files.map(async (fileName) => {
      const absolutePath = path.join(dir, fileName);
      const relativePath = path.relative(meta.root, absolutePath);
      if (meta.ignore.ignores(relativePath)) {
        return;
      }
      const stats = await fsp.stat(absolutePath);
      if (stats.isDirectory()) {
        for (const [relativePath, hash] of (
          await walk(absolutePath, makeChildMeta(absolutePath, meta))
        ).entries()) {
          hashes.set(relativePath, hash);
        }
      } else if (stats.isFile()) {
        hashes.set(relativePath, await hashFile(absolutePath));
      }
    }),
  );
  return hashes;
};

const hashLockfile = async (dir: string) => {
  const name = await findUp(dir, [
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
  ]);
  if (!name) return undefined;
  return {
    name,
    hash: await hashFile(name),
  };
};

const readIgnore = memoize(async (path: string) => {
  try {
    const content = await fsp.readFile(path, "utf-8");
    const rules = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return rules;
  } catch {
    return undefined;
  }
});

const pathsBetween = (parent: string, child: string) => {
  const paths: Array<string> = [];
  let dir = child;
  while (dir !== parent) {
    paths.push(dir);
    dir = path.dirname(dir);
  }
  paths.push(parent);
  return paths;
};

const buildRootIgnore = async (root: string, cwd: string) => {
  const ignore = new Ignore().add([".git", ".gitignore"]);
  const paths = pathsBetween(root, cwd);
  const files = await Promise.all(
    paths.map((dir) => readIgnore(path.join(dir, ".gitignore"))),
  );
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i]) {
      ignore.add(files[i]);
    }
  }
  return ignore;
};

const merge = <K, V>(maps: Array<Map<K, V>>): Map<K, V> => {
  if (maps.length === 0) return new Map();
  if (maps.length === 1) return maps[0];
  const merged = new Map<K, V>();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, value);
    }
  }
  return merged;
};

export const combineHashes = (hashes: Array<Map<string, string>>) => {
  const merged = merge(hashes);
  const paths = Array.from(merged.keys()).sort();
  const hash = crypto.createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update(merged.get(path)!);
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const hashDirectory = async (dir: string) => {
  const parentPromise = makeParent(dir);
  const [files, lockfileHash] = await Promise.all([
    walk(dir, parentPromise),
    hashLockfile(dir),
  ]);
  if (lockfileHash) {
    const relativePath = path.relative(
      (await parentPromise).root,
      lockfileHash.name,
    );
    files.set(relativePath, lockfileHash.hash);
  }
  return files;
};

export function hashPlugin(): Plugin {
  let root = process.cwd();
  const workspaces = new Set<string>([root]);
  const promises: Array<Promise<void>> = [];
  const seen = new Set<string>();
  const envs = new Map<string, boolean>();

  const isDone = () => Array.from(envs.values()).every((done) => done);

  const done = async () => {
    await Promise.all(promises);
    const hashes = await Promise.all(Array.from(workspaces).map(hashDirectory));
    const hash = combineHashes(hashes);
    return {
      hash,
      workspaces: Array.from(workspaces).map((workspace) =>
        path.relative(root, workspace),
      ),
    };
  };

  const redo = async (workspaces: Array<string>) => {
    const hashes = await Promise.all(
      workspaces.map((dir) => path.resolve(root, dir)).map(hashDirectory),
    );
    const hash = combineHashes(hashes);
    return hash;
  };

  return {
    name: "hash",
    configResolved(config) {
      root = path.resolve(config.root);
      for (const env of Object.keys(config.environments)) {
        envs.set(env, false);
      }
    },
    async writeBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (info) {
          if (seen.has(info.id)) {
            continue;
          }
          seen.add(info.id);
          if (
            !info.code ||
            info.id.includes("node_modules") ||
            !path.isAbsolute(info.id) ||
            info.id.startsWith(root)
          ) {
            continue;
          }
          promises.push(
            findUp(path.dirname(info.id), ["package.json"]).then((pkgPath) => {
              if (pkgPath) {
                workspaces.add(path.dirname(pkgPath));
              }
            }),
          );
        }
      }
      envs.set(this.environment.name, true);
      if (isDone()) {
        const { hash, workspaces } = await done();
        console.log({ hash, workspaces });
        const redoHash = await redo(workspaces);
        console.log({ redoHash });
      }
    },
  };
}
