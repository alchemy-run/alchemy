import { afterAll, beforeAll, deploy, destroy, expect, test } from "alchemy-effect/Test/Bun";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// --- helpers ---

const AUTH_TOKEN = "test-bearer-token";

function createTgz(content: string): Uint8Array {
  // Minimal valid gzip: 10-byte header + deflated payload + 8-byte trailer.
  // For testing we just need something that starts with 0x1f 0x8b (gzip magic).
  const encoder = new TextEncoder();
  const payload = encoder.encode(content);
  // gzip magic (1f 8b), method deflate (08), no flags, no mtime/xfl/os
  const header = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]);
  const result = new Uint8Array(header.length + payload.length);
  result.set(header);
  result.set(payload, header.length);
  return result;
}

function upload(
  baseUrl: string,
  file: Uint8Array,
  tags: string[],
  options?: { ttl?: number; token?: string; filename?: string },
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([file], { type: "application/gzip" }),
    options?.filename ?? "package.tgz",
  );
  form.append("tags", JSON.stringify(tags));
  if (options?.ttl !== undefined) {
    form.append("ttl", String(options.ttl));
  }
  return fetch(`${baseUrl}/packages`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${options?.token ?? AUTH_TOKEN}` },
    body: form,
  });
}

function getByTag(baseUrl: string, tag: string) {
  return fetch(`${baseUrl}/tags/${tag}`);
}

function deleteTag(baseUrl: string, tag: string, token?: string) {
  return fetch(`${baseUrl}/tags/${tag}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token ?? AUTH_TOKEN}` },
  });
}

function getStats(baseUrl: string, resourceId: string, token?: string) {
  return fetch(`${baseUrl}/packages/${resourceId}/stats`, {
    headers: { Authorization: `Bearer ${token ?? AUTH_TOKEN}` },
  });
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

    const d1 = new Uint8Array(
      yield* Effect.promise(() => g1.arrayBuffer()),
    );
    const d2 = new Uint8Array(
      yield* Effect.promise(() => g2.arrayBuffer()),
    );
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
    const data = new Uint8Array(
      yield* Effect.promise(() => gB.arrayBuffer()),
    );
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
  "reject non-.tgz upload",
  Effect.gen(function* () {
    const url = yield* stack;
    const txt = new TextEncoder().encode("not a tgz");

    const res = yield* Effect.promise(() =>
      upload(url, txt, ["bad"], { filename: "readme.txt" }),
    );
    expect(res.status).toBe(400);
    const body = yield* Effect.promise(() => res.json());
    expect(body.error).toContain("tgz");
  }),
);

test(
  "reject upload with invalid gzip magic bytes",
  Effect.gen(function* () {
    const url = yield* stack;
    const fake = new Uint8Array([0x00, 0x00, 0x08, 0x00]);

    const res = yield* Effect.promise(() =>
      upload(url, fake, ["bad-magic"], { filename: "package.tgz" }),
    );
    expect(res.status).toBe(400);
  }),
);

test(
  "PUT and DELETE require auth, GET does not",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("auth-test");

    // PUT without token
    const form = new FormData();
    form.append(
      "file",
      new Blob([content], { type: "application/gzip" }),
      "package.tgz",
    );
    form.append("tags", JSON.stringify(["auth-tag"]));
    const noAuthPut = yield* Effect.promise(() =>
      fetch(`${url}/packages`, { method: "PUT", body: form }),
    );
    expect(noAuthPut.status).toBe(401);

    // DELETE without token
    const noAuthDel = yield* Effect.promise(() =>
      fetch(`${url}/tags/auth-tag`, { method: "DELETE" }),
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

    const res = yield* Effect.promise(() =>
      getByTag(url, "does-not-exist"),
    );
    expect(res.status).toBe(404);
  }),
);

test(
  "upload same content with different tags deduplicates",
  Effect.gen(function* () {
    const url = yield* stack;
    const content = createTgz("dedup-content");

    const r1 = yield* Effect.promise(() =>
      upload(url, content, ["dedup-a"]).then((r) => r.json()),
    );
    const r2 = yield* Effect.promise(() =>
      upload(url, content, ["dedup-b"]).then((r) => r.json()),
    );

    // same content hash => same resourceId
    expect(r1.resourceId).toBe(r2.resourceId);

    // both tags work
    const g1 = yield* Effect.promise(() => getByTag(url, "dedup-a"));
    const g2 = yield* Effect.promise(() => getByTag(url, "dedup-b"));
    expect(g1.status).toBe(200);
    expect(g2.status).toBe(200);
  }),
);

test.skipIf(!!process.env.NO_DESTROY)(
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
      upload(url, content, ["ttl-test"], { ttl: 7 }),
    );
    expect(res.status).toBe(200);
    const body = yield* Effect.promise(() => res.json());
    expect(body.ttl).toBe(7);
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
    const statsRes = yield* Effect.promise(() =>
      getStats(url, r1.resourceId),
    );
    expect(statsRes.status).toBe(404);
  }),
);
