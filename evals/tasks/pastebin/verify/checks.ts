/**
 * Hidden acceptance suite for `pastebin`. Lives grader-side (never copied
 * into agent workspaces) and asserts only contract-visible behavior.
 */
import type { CheckResult, VerifyContext } from "../../../runner/types.ts";

const get = async (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(15_000) });
const post = async (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

/** D1 reads are eventually consistent enough to warrant one bounded retry loop. */
const retry = async <T>(fn: () => Promise<T>, times = 5): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < times; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000 * (attempt + 1));
    }
  }
  throw lastError;
};

export async function run(context: VerifyContext): Promise<CheckResult[]> {
  const base = context.url;
  const results: CheckResult[] = [];
  const marker = `eval-${crypto.randomUUID()}`;

  // create — POST /pastes → 201 {id, url}
  let created: { id?: string; url?: string } = {};
  try {
    const response = await retry(async () => {
      const r = await post(`${base}/pastes`, { content: marker });
      if (r.status !== 201) throw new Error(`status ${r.status}`);
      return r;
    });
    created = (await response.json()) as typeof created;
    const idOk =
      typeof created.id === "string" &&
      created.id.length >= 8 &&
      /^[A-Za-z0-9_-]+$/.test(created.id);
    const urlOk =
      typeof created.url === "string" && created.url.startsWith("http");
    results.push({
      id: "create",
      pass: idOk && urlOk,
      detail: idOk && urlOk ? undefined : JSON.stringify(created).slice(0, 300),
    });
  } catch (error) {
    results.push({ id: "create", pass: false, detail: String(error) });
  }

  // read-back — GET /pastes/:id round-trips content + createdAt
  if (created.id) {
    try {
      const response = await retry(async () => {
        const r = await get(`${base}/pastes/${created.id}`);
        if (r.status !== 200) throw new Error(`status ${r.status}`);
        return r;
      });
      const body = (await response.json()) as {
        id?: string;
        content?: string;
        createdAt?: string;
      };
      const pass =
        body.id === created.id &&
        body.content === marker &&
        typeof body.createdAt === "string" &&
        !Number.isNaN(Date.parse(body.createdAt));
      results.push({
        id: "read-back",
        pass,
        detail: pass ? undefined : JSON.stringify(body).slice(0, 300),
      });
    } catch (error) {
      results.push({ id: "read-back", pass: false, detail: String(error) });
    }
  } else {
    results.push({ id: "read-back", pass: false, detail: "no id from create" });
  }

  // read-url — the returned absolute url serves the same paste
  if (created.url) {
    try {
      const response = await get(created.url);
      const body = (await response.json()) as { content?: string };
      results.push({
        id: "read-url",
        pass: response.status === 200 && body.content === marker,
        detail:
          response.status === 200 ? undefined : `status ${response.status}`,
      });
    } catch (error) {
      results.push({ id: "read-url", pass: false, detail: String(error) });
    }
  } else {
    results.push({ id: "read-url", pass: false, detail: "no url from create" });
  }

  // not-found — unknown id → 404 {error:"not_found"}
  try {
    const response = await get(`${base}/pastes/missing${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    results.push({
      id: "not-found",
      pass: response.status === 404 && body.error === "not_found",
      detail:
        response.status === 404
          ? JSON.stringify(body).slice(0, 200)
          : `status ${response.status}`,
    });
  } catch (error) {
    results.push({ id: "not-found", pass: false, detail: String(error) });
  }

  // distinct-ids — two creates yield different ids (no fixed/global id)
  try {
    const first = await post(`${base}/pastes`, { content: "a" });
    const second = await post(`${base}/pastes`, { content: "b" });
    const firstBody = (await first.json()) as { id?: string };
    const secondBody = (await second.json()) as { id?: string };
    results.push({
      id: "distinct-ids",
      pass:
        typeof firstBody.id === "string" &&
        typeof secondBody.id === "string" &&
        firstBody.id !== secondBody.id,
    });
  } catch (error) {
    results.push({ id: "distinct-ids", pass: false, detail: String(error) });
  }

  return results;
}
