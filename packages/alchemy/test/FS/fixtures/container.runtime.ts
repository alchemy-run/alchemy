import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import * as FS from "@/FS/index.ts";
import * as Git from "@/Git/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { MountBox } from "./container.ts";
import { AgentRepo, DocsRepo, GIT_CREDENTIALS, ScratchRepo } from "./repo.ts";

export const Settings = FS.File('{"model":"haiku"}\n');
export const Script = FS.File("#!/bin/sh\necho hi\n", { mode: 0o755 });
export const Folder = FS.Folder(`${import.meta.dirname}/folder`);

/** Facts about the mounts, gathered inside the container. */
const CHECK = `
set +e
echo "file=$(cat /etc/mounts/settings.json)"
echo "script=$(/usr/local/bin/hi)"
echo "folder=$(cat /opt/folder/a.txt)|$(cat /opt/folder/nested/b.txt)"
for p in /workspace/hello-ro /workspace/hello-rw /workspace/docs /workspace/scratch; do
  n=$(basename $p)
  echo "$n.readme=$(head -n1 $p/README 2>/dev/null || head -n1 $p/README.md 2>/dev/null)"
  echo "$n.branch=$(git -C $p rev-parse --abbrev-ref HEAD)"
  echo "$n.upstream=$(git -C $p rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)"
  echo "$n.pushurl=$(git -C $p remote get-url --push origin)"
  echo "$n.cred=$(printf 'protocol=https\\nhost=example.com\\n\\n' | git -C $p credential fill 2>/dev/null | grep password= | cut -d= -f2)"
done
# The deploy key the token-less mount created: read (ls-remote) and write (push --dry-run).
echo "agent.readme=$(head -n1 /workspace/agent/README.md)"
echo "agent.lsremote=$(git -C /workspace/agent ls-remote origin HEAD >/dev/null 2>&1 && echo ok || echo failed)"
echo "agent.push=$(git -C /workspace/agent push --dry-run origin HEAD:refs/heads/deploy-key-check >/dev/null 2>&1 && echo ok || echo failed)"
`;

export default MountBox.make(
  { main: import.meta.url, runtime: "node", image: "node:22-bookworm-slim" },
  Effect.gen(function* () {
    yield* FS.MountFile(Settings, { path: "/etc/mounts/settings.json" });
    yield* FS.MountFile(Script, { path: "/usr/local/bin/hi" });
    yield* FS.MountFolder(Folder, { path: "/opt/folder" });
    yield* GitHub.MountRepository("octocat/Hello-World", {
      path: "/workspace/hello-ro",
      ref: "master",
      access: "read",
      token: Redacted.make("read-token"),
    });
    yield* GitHub.MountRepository("octocat/Hello-World", {
      path: "/workspace/hello-rw",
      ref: "master",
      access: "write",
      token: Redacted.make("write-token"),
    });
    yield* Git.MountRepository(yield* DocsRepo, {
      path: "/workspace/docs",
      access: "write",
      credentials: GIT_CREDENTIALS,
    });
    // No token: GitHub access comes from an auto-created deploy key.
    yield* GitHub.MountRepository(yield* AgentRepo, {
      path: "/workspace/agent",
      access: "write",
    });
    yield* Cloudflare.Artifacts.MountRepository(yield* ScratchRepo, {
      path: "/workspace/scratch",
      access: "read",
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!request.url.endsWith("/check")) return HttpServerResponse.text("ok");
        const spawner = yield* ChildProcessSpawner;
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", CHECK]));
        const out = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
        return HttpServerResponse.text(out);
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
);
