import {
  afterAll,
  beforeAll,
  deploy,
  destroy,
  expect,
  test,
} from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

async function waitForWorker(url: string, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/health`);
      // Our worker returns 404 with text "Not Found" for unknown routes.
      // Cloudflare's edge 404 (route not ready) has a different body.
      // Also skip 521/522 (worker not reachable).
      const body = await res.text();
      if (body === "Not Found" || res.status === 200) return;
    } catch {
      // network error, keep retrying
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Worker not reachable after retries");
}

// Deploy stack and wait for worker to be reachable
const stack = beforeAll(
  Effect.gen(function* () {
    const output = yield* deploy(Stack);
    const url = output.url as string;
    yield* Effect.promise(() => waitForWorker(url));
    return url;
  }),
  { timeout: 180_000 },
);
// afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// --- helpers ---

const AUTH_TOKEN = "test-bearer-token";
const DEFAULT_PROJECT = "test-project";

function createTgz(content: string): Uint8Array<ArrayBuffer> {
  // Minimal valid gzip: 10-byte header + deflated payload + 8-byte trailer.
  // For testing we just need something that starts with 0x1f 0x8b (gzip magic).
  const encoder = new TextEncoder();
  const payload = encoder.encode(content);
  // gzip magic (1f 8b), method deflate (08), no flags, no mtime/xfl/os
  const header = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]);
  const result = new Uint8Array(
    new ArrayBuffer(header.length + payload.length),
  );
  result.set(header);
  result.set(payload, header.length);
  return result;
}

function upload(
  baseUrl: string,
  file: Uint8Array<ArrayBuffer>,
  tags: string[],
  options?: { ttl?: string; token?: string; project?: string },
) {
  const project = options?.project ?? DEFAULT_PROJECT;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options?.token ?? AUTH_TOKEN}`,
    "Content-Type": "application/gzip",
    "X-Tags": JSON.stringify(tags),
  };
  if (options?.ttl !== undefined) {
    headers["X-TTL"] = options.ttl;
  }
  return fetch(`${baseUrl}/projects/${project}/packages`, {
    method: "PUT",
    headers,
    body: file,
  });
}

function getByTag(baseUrl: string, tag: string, project?: string) {
  return fetch(`${baseUrl}/projects/${project ?? DEFAULT_PROJECT}/tags/${tag}`);
}

function deleteTag(
  baseUrl: string,
  tag: string,
  options?: { token?: string; project?: string },
) {
  return fetch(
    `${baseUrl}/projects/${options?.project ?? DEFAULT_PROJECT}/tags/${tag}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${options?.token ?? AUTH_TOKEN}` },
    },
  );
}

function getStats(
  baseUrl: string,
  resourceId: string,
  options?: { token?: string; project?: string },
) {
  return fetch(
    `${baseUrl}/projects/${options?.project ?? DEFAULT_PROJECT}/packages/${resourceId}/stats`,
    {
      headers: { Authorization: `Bearer ${options?.token ?? AUTH_TOKEN}` },
    },
  );
}

// --- tests ---

test(
  "upload a package with a tag and retrieve it",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("package-v1");

    const uploadRes = yield* Effect.promise(() =>
      upload(url, content, ["latest"]),
    );
    expect(uploadRes.status).toBe(200);
    const body = yield* Effect.promise(() => uploadRes.json());
    expect(body.resourceId).toBeString();
    expect(body.tags).toEqual(["latest"]);

    const getRes = yield* Effect.promise(() => getByTag(url, "latest"));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("application/gzip");
    const data = new Uint8Array(
      yield* Effect.promise(() => getRes.arrayBuffer()),
    );
    expect(data).toEqual(content);

    // verify the tag endpoint redirects to the resource URL
    const redirectRes = yield* Effect.promise(() =>
      fetch(`${url}/projects/${DEFAULT_PROJECT}/tags/latest`),
    );
    expect(redirectRes.redirected).toBe(true);
    expect(redirectRes.url).toContain(
      `/projects/${DEFAULT_PROJECT}/packages/${body.resourceId}`,
    );

    // verify the resource URL is cacheable
    const directRes = yield* Effect.promise(() =>
      fetch(`${url}/projects/${DEFAULT_PROJECT}/packages/${body.resourceId}`),
    );
    expect(directRes.status).toBe(200);
    expect(directRes.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  }),
);

test(
  "tag reassignment returns new content and cleans up orphan",
  Effect.gen(function* () {
    const url = yield* stack;
    const v1 = createTgz("reassign-v1");
    const v2 = createTgz("reassign-v2");

    const r1 = yield* Effect.promise(() =>
      upload(url, v1, ["reassign"]).then((r) => r.json()),
    );
    const r2 = yield* Effect.promise(() =>
      upload(url, v2, ["reassign"]).then((r) => r.json()),
    );

    // tag now points to v2
    const getRes = yield* Effect.promise(() => getByTag(url, "reassign"));
    expect(getRes.status).toBe(200);
    const data = new Uint8Array(
      yield* Effect.promise(() => getRes.arrayBuffer()),
    );
    expect(data).toEqual(v2);

    // v1 was orphaned (had no other tags) so it should be gone
    expect(r1.resourceId).not.toBe(r2.resourceId);
  }),
);

test(
  "multiple tags resolve to the same resource",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("multi-tag");

    const res = yield* Effect.promise(() =>
      upload(url, content, ["v1", "stable"]).then((r) => r.json()),
    );

    const g1 = yield* Effect.promise(() => getByTag(url, "v1"));
    const g2 = yield* Effect.promise(() => getByTag(url, "stable"));
    expect(g1.status).toBe(200);
    expect(g2.status).toBe(200);

    const d1 = new Uint8Array(yield* Effect.promise(() => g1.arrayBuffer()));
    const d2 = new Uint8Array(yield* Effect.promise(() => g2.arrayBuffer()));
    expect(d1).toEqual(content);
    expect(d2).toEqual(content);
  }),
);

test(
  "delete tag (not last) keeps resource accessible via remaining tag",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("del-not-last");

    yield* Effect.promise(() => upload(url, content, ["tagA", "tagB"]));

    const delRes = yield* Effect.promise(() => deleteTag(url, "tagA"));
    expect(delRes.status).toBe(200);

    // tagA should 404
    const gA = yield* Effect.promise(() => getByTag(url, "tagA"));
    expect(gA.status).toBe(404);

    // tagB still works
    const gB = yield* Effect.promise(() => getByTag(url, "tagB"));
    expect(gB.status).toBe(200);
    const data = new Uint8Array(yield* Effect.promise(() => gB.arrayBuffer()));
    expect(data).toEqual(content);
  }),
);

test(
  "delete last tag removes resource",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("del-last");

    yield* Effect.promise(() => upload(url, content, ["lonely"]));

    const delRes = yield* Effect.promise(() => deleteTag(url, "lonely"));
    expect(delRes.status).toBe(200);

    const getRes = yield* Effect.promise(() => getByTag(url, "lonely"));
    expect(getRes.status).toBe(404);
  }),
);

test(
  "upload requires X-Tags header",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("no-tags");

    const res = yield* Effect.promise(() =>
      fetch(`${url}/projects/${DEFAULT_PROJECT}/packages`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/gzip",
        },
        body: content,
      }),
    );
    expect(res.status).toBe(400);
    const body = yield* Effect.promise(() => res.json());
    expect(body.error).toContain("X-Tags");
  }),
);

test(
  "PUT and DELETE require auth, GET does not",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("auth-test");

    // PUT without token
    const noAuthPut = yield* Effect.promise(() =>
      fetch(`${url}/projects/${DEFAULT_PROJECT}/packages`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "X-Tags": JSON.stringify(["auth-tag"]),
        },
        body: content,
      }),
    );
    expect(noAuthPut.status).toBe(401);

    // DELETE without token
    const noAuthDel = yield* Effect.promise(() =>
      fetch(`${url}/projects/${DEFAULT_PROJECT}/tags/auth-tag`, {
        method: "DELETE",
      }),
    );
    expect(noAuthDel.status).toBe(401);

    // upload with auth so we can verify GET works without it
    yield* Effect.promise(() => upload(url, content, ["auth-tag"]));

    // GET without token should succeed
    const getRes = yield* Effect.promise(() => getByTag(url, "auth-tag"));
    expect(getRes.status).toBe(200);
  }),
);

test(
  "PUT with wrong token returns 401",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("wrong-token");

    const res = yield* Effect.promise(() =>
      upload(url, content, ["nope"], { token: "wrong-token" }),
    );
    expect(res.status).toBe(401);
  }),
);

test(
  "GET nonexistent tag returns 404",
  Effect.gen(function* () {
    const url = yield* stack;

    const res = yield* Effect.promise(() => getByTag(url, "does-not-exist"));
    expect(res.status).toBe(404);
  }),
);

test(
  "download tracking records tag used",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("stats-content");

    const uploaded = yield* Effect.promise(() =>
      upload(url, content, ["stats-a", "stats-b"]).then((r) => r.json()),
    );

    // download via both tags
    yield* Effect.promise(() => getByTag(url, "stats-a"));
    yield* Effect.promise(() => getByTag(url, "stats-a"));
    yield* Effect.promise(() => getByTag(url, "stats-b"));

    const statsRes = yield* Effect.promise(() =>
      getStats(url, uploaded.resourceId),
    );
    expect(statsRes.status).toBe(200);
    const stats = yield* Effect.promise(() => statsRes.json());
    expect(stats.totalDownloads).toBe(3);
    expect(stats.downloads["stats-a"]).toBe(2);
    expect(stats.downloads["stats-b"]).toBe(1);
  }),
);

test(
  "custom ttl is accepted on upload",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("ttl-custom");

    const res = yield* Effect.promise(() =>
      upload(url, content, ["ttl-test"], { ttl: "7 hours" }),
    );
    expect(res.status).toBe(200);
    const body = yield* Effect.promise(() => res.json());
    expect(body.ttl).toBe("7 hours");
    // expiresAt should be ~7 hours from now
    const sevenHoursMs = 7 * 60 * 60 * 1000;
    expect(body.expiresAt).toBeGreaterThan(Date.now() + sevenHoursMs - 60_000);
    expect(body.expiresAt).toBeLessThan(Date.now() + sevenHoursMs + 60_000);
  }),
);

test(
  "reassigning a tag that was the last tag on old resource cleans it up",
  Effect.gen(function* () {
    const url = yield* stack;
    const v1 = createTgz("orphan-v1");
    const v2 = createTgz("orphan-v2");

    const r1 = yield* Effect.promise(() =>
      upload(url, v1, ["orphan-tag"]).then((r) => r.json()),
    );

    // r1 now has one tag: "orphan-tag"
    // uploading v2 with same tag should orphan r1
    yield* Effect.promise(() => upload(url, v2, ["orphan-tag"]));

    // stats for old resource should 404 (it was cleaned up)
    const statsRes = yield* Effect.promise(() => getStats(url, r1.resourceId));
    expect(statsRes.status).toBe(404);
  }),
);

test(
  "same tag on different projects points to different resources",
  Effect.gen(function* () {
    const url = yield* stack;
    const contentA = createTgz("project-a-content");
    const contentB = createTgz("project-b-content");

    const resA = yield* Effect.promise(() =>
      upload(url, contentA, ["latest"], { project: "repo-alpha" }).then((r) =>
        r.json(),
      ),
    );
    const resB = yield* Effect.promise(() =>
      upload(url, contentB, ["latest"], { project: "repo-beta" }).then((r) =>
        r.json(),
      ),
    );

    // different resources
    expect(resA.resourceId).not.toBe(resB.resourceId);
    expect(resA.project).toBe("repo-alpha");
    expect(resB.project).toBe("repo-beta");

    // each project's "latest" resolves to its own content
    const getA = yield* Effect.promise(() =>
      getByTag(url, "latest", "repo-alpha"),
    );
    const getB = yield* Effect.promise(() =>
      getByTag(url, "latest", "repo-beta"),
    );
    expect(getA.status).toBe(200);
    expect(getB.status).toBe(200);

    const dataA = new Uint8Array(
      yield* Effect.promise(() => getA.arrayBuffer()),
    );
    const dataB = new Uint8Array(
      yield* Effect.promise(() => getB.arrayBuffer()),
    );
    expect(dataA).toEqual(contentA);
    expect(dataB).toEqual(contentB);

    // deleting tag on one project doesn't affect the other
    yield* Effect.promise(() =>
      deleteTag(url, "latest", { project: "repo-alpha" }),
    );
    const getAAfter = yield* Effect.promise(() =>
      getByTag(url, "latest", "repo-alpha"),
    );
    expect(getAAfter.status).toBe(404);

    const getBAfter = yield* Effect.promise(() =>
      getByTag(url, "latest", "repo-beta"),
    );
    expect(getBAfter.status).toBe(200);
  }),
);
