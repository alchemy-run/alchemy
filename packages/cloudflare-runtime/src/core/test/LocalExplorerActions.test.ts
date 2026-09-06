import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as KvNamespace from "../bindings/kv-namespace/KvNamespace.ts";
import * as R2Bucket from "../bindings/r2-bucket/R2Bucket.ts";
import * as SendEmail from "../bindings/send-email/SendEmail.ts";
import type { RuntimeWorker } from "../RuntimeWorker.ts";
import { localRuntimeLayer, poll, startTestWorker } from "./helpers/runtime.ts";

const API = "/cdn-cgi/local/explorer/api";
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const owner: RuntimeWorker = {
  name: "explorer-actions-owner",
  localExplorer: true,
  compatibilityDate: "2026-08-31",
  compatibilityFlags: ["nodejs_compat"],
  workflows: [{ workflowName: "explorer-actions-flow", className: "Flow" }],
  bindings: [
    KvNamespace.local({ binding: "KV", id: "actions-kv" }),
    R2Bucket.local({ binding: "R2", id: "actions-r2" }),
    SendEmail.local({
      binding: "MAIL",
      allowedSenderAddresses: ["sender@example.com"],
    }),
  ],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: `
import { WorkflowEntrypoint } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
export class Flow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("start", async () => event.payload, { rollback: async () => this.env.KV.put("rollback", "completed") });
    if (event.payload.wait) return (await step.waitForEvent("approval", { type: "approve", timeout: "1 hour" })).payload;
    return event.payload;
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      try { return Response.json(await env.MAIL.send(await request.json())); }
      catch (error) { return new Response(error.message, { status: 400 }); }
    }
    if (url.pathname === "/raw") {
      return Response.json(await env.MAIL.send(new EmailMessage("sender@example.com", "recipient@example.com", await request.text())));
    }
    if (url.pathname === "/kv") return new Response(await env.KV.get(url.searchParams.get("key")));
    if (url.pathname === "/r2") {
      const object = await env.R2.get(url.searchParams.get("key"));
      return object ? new Response(object.body) : new Response("missing", { status: 404 });
    }
    return new Response("ok");
  },
  async email(message, env) {
    const subject = message.headers.get("subject");
    await env.KV.put("incoming", subject);
    if (subject === "reject") message.setReject("Test rejection");
    if (subject === "forward") await message.forward("forward@example.com");
    if (subject === "reply") {
      const raw = ["From: recipient@example.com", "To: sender@example.com", "Message-ID: <reply@example.com>",
        "In-Reply-To: " + message.headers.get("message-id"), "Subject: Re: reply", "", "Reply body"].join("\\r\\n");
      await message.reply(new EmailMessage("recipient@example.com", "sender@example.com", raw));
    }
    if (subject === "exception") throw new Error("Test email failure");
  }
};
`,
    },
  ],
};
const peerConfig: RuntimeWorker = {
  name: "explorer-actions-peer",
  localExplorer: true,
  compatibilityDate: "2026-08-31",
  compatibilityFlags: [],
  bindings: [],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: "export default { fetch() { return new Response('peer'); } };",
    },
  ],
};

layer(localRuntimeLayer)("Local Explorer actions", (it) => {
  it.effect(
    "edits live KV/R2 and captures email across workers and restart",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const worker = yield* startTestWorker(owner).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const peer = yield* startTestWorker(peerConfig);
        yield* poll<{ result: { name: string }[] }>(
          peer,
          `${API}/local/workers`,
          (body) => body.result.some((w) => w.name === owner.name),
        );
        const key = "folder/a ?é";
        const kv = `${API}/storage/kv/namespaces/actions-kv`;
        const kvValue = `${kv}/values/${encodeURIComponent(key)}`;
        const form = new FormData();
        form.set("value", "from explorer");
        form.set("metadata", JSON.stringify({ source: "test" }));
        expect(
          (yield* peer.fetch(kvValue, { method: "PUT", body: form })).status,
        ).toBe(200);
        expect(
          yield* worker.fetchText(`/kv?key=${encodeURIComponent(key)}`),
        ).toBe("from explorer");
        expect(yield* peer.fetchJson(`${kv}/keys`)).toMatchObject({
          result: [{ name: key, metadata: { source: "test" } }],
        });
        expect(
          (yield* peer.fetch(kvValue, { method: "PUT", body: "updated" }))
            .status,
        ).toBe(200);
        expect(
          yield* worker.fetchText(`/kv?key=${encodeURIComponent(key)}`),
        ).toBe("updated");
        expect((yield* peer.fetch(kvValue, { method: "DELETE" })).status).toBe(
          200,
        );
        expect((yield* peer.fetch(kvValue)).status).toBe(404);
        const r2 = `${API}/r2/buckets/actions-r2/objects`;
        const object = `${r2}/${encodeURIComponent(key)}`;
        expect(
          (yield* peer.fetch(object, {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "cf-r2-custom-metadata": JSON.stringify({ source: "test" }),
            },
            body: new Uint8Array([0, 1, 255]),
          })).status,
        ).toBe(200);
        expect(
          Array.from(
            new Uint8Array(
              yield* Effect.promise(() =>
                globalThis
                  .fetch(
                    new URL(
                      `/r2?key=${encodeURIComponent(key)}`,
                      worker.baseUrl,
                    ),
                  )
                  .then((r) => r.arrayBuffer()),
              ),
            ),
          ),
        ).toEqual([0, 1, 255]);
        expect((yield* peer.fetch(r2, json([key], "DELETE"))).status).toBe(200);
        expect(
          (yield* worker.fetch(`/r2?key=${encodeURIComponent(key)}`)).status,
        ).toBe(404);

        const email = {
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Explorer email",
          text: "Plain body",
          html: "<p>HTML body</p>",
          attachments: [
            {
              filename: "test.txt",
              type: "text/plain",
              content: "YXR0YWNobWVudA==",
            },
          ],
        };
        const sent = yield* worker.fetchJson<{ messageId: string }>(
          "/send",
          json(email),
        );
        expect(sent.messageId).toBeTruthy();
        expect(
          (yield* worker.fetch(
            "/send",
            json({ ...email, from: "denied@example.com" }),
          )).status,
        ).toBe(400);
        const sending = `${API}/local/email/sending`;
        expect(yield* peer.fetchJson(sending)).toMatchObject({
          result: [
            {
              messageId: sent.messageId,
              worker: owner.name,
              subject: email.subject,
            },
          ],
        });
        expect(
          yield* peer.fetchJson(
            `${sending}?worker=${owner.name}&email_id=${encodeURIComponent(sent.messageId)}`,
          ),
        ).toMatchObject({
          result: {
            text: email.text,
            html: email.html,
            attachments: [{ filename: "test.txt" }],
          },
        });
        expect(
          yield* peer.fetchJson(`${sending}?worker=${peerConfig.name}`),
        ).toMatchObject({ result: [] });
        const routing = `${API}/local/email/routing`;
        for (const subject of [
          "receive",
          "reject",
          "forward",
          "reply",
          "exception",
        ]) {
          const delivered = yield* peer.fetchJson<{
            result: {
              messageId: string;
              outcome: string;
              rejectReason?: string;
            };
          }>(
            `${routing}/send?worker=${owner.name}`,
            json({ ...email, subject }),
          );
          expect(delivered.result, JSON.stringify(delivered)).toMatchObject({
            outcome: subject === "exception" ? "exception" : "ok",
          });
          if (subject === "reject")
            expect(delivered.result.rejectReason).toBe("Test rejection");
          expect(yield* worker.fetchText("/kv?key=incoming")).toBe(subject);
          const captured = yield* peer.fetchJson<{
            result: {
              subject: string;
              raw: string;
              replies: unknown[];
              forwards: unknown[];
            };
          }>(
            `${routing}?worker=${owner.name}&email_id=${encodeURIComponent(delivered.result.messageId)}`,
          );
          expect(captured.result.subject).toBe(subject);
          expect(captured.result.raw).toContain("Subject: " + subject);
          if (subject === "reply")
            expect(captured.result.replies).toHaveLength(1);
          if (subject === "forward")
            expect(captured.result.forwards).toHaveLength(1);
        }
        expect(
          (yield* peer.fetch(
            `${routing}/send?worker=${peerConfig.name}`,
            json(email),
          )).status,
        ).toBe(400);
        expect(
          (yield* peer.fetch(
            `${routing}/send?worker=${owner.name}`,
            json({ ...email, to: [] }),
          )).status,
        ).toBe(400);
        const raw =
          "From: sender@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <raw-test@example.com>\r\nSubject: raw test\r\n\r\nRaw body";
        const rawSent = yield* worker.fetchJson<{ messageId: string }>("/raw", {
          method: "POST",
          body: raw,
        });
        expect(
          yield* peer.fetchJson(
            `${sending}?email_id=${encodeURIComponent(rawSent.messageId)}`,
          ),
        ).toMatchObject({
          result: {
            raw: expect.stringContaining("Raw body"),
            rawBase64: expect.any(String),
          },
        });
        expect(
          (yield* worker.fetch(
            "/cdn-cgi/handler/email?from=sender@example.com&to=recipient@example.com",
            { method: "POST", body: raw },
          )).status,
        ).toBe(200);
        expect(
          yield* peer.fetchJson(
            `${routing}?email_id=${encodeURIComponent("<raw-test@example.com>")}`,
          ),
        ).toMatchObject({ result: { subject: "raw test" } });
        yield* Scope.close(scope, Exit.void);
        const restarted = yield* startTestWorker(owner);
        expect(
          yield* restarted.fetchJson(
            `${sending}?email_id=${encodeURIComponent(sent.messageId)}`,
          ),
        ).toMatchObject({ result: { subject: email.subject } });
        expect(
          yield* restarted.fetchJson(
            `${routing}?email_id=${encodeURIComponent("<raw-test@example.com>")}`,
          ),
        ).toMatchObject({ result: { subject: "raw test" } });
      }),
    { timeout: 90_000 },
  );

  it.effect(
    "creates, controls, signals and deletes live Workflow instances",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          ...owner,
          name: "explorer-workflow-owner",
        });
        const peer = yield* startTestWorker({
          ...peerConfig,
          name: "explorer-workflow-peer",
        });
        const workflow = `${API}/workflows/explorer-actions-flow`;
        yield* poll<{ result: { name: string }[] }>(
          peer,
          `${API}/workflows`,
          (body) => body.result.some((w) => w.name === "explorer-actions-flow"),
        );
        const instances = `${workflow}/instances`;
        expect(
          yield* peer.fetchJson(
            instances,
            json({ id: "controlled", params: { wait: true } }),
          ),
        ).toMatchObject({ result: { id: "controlled" } });
        const instance = `${instances}/controlled`;
        yield* poll<{ result: { steps: { type: string }[] } }>(
          peer,
          instance,
          (body) => body.result.steps.some((s) => s.type === "waitForEvent"),
        );
        for (const action of ["pause", "resume", "terminate", "restart"]) {
          expect(
            yield* peer.fetchJson(
              `${instance}/status`,
              json({ action }, "PATCH"),
            ),
          ).toMatchObject({ success: true });
        }
        yield* poll<{ result: { steps: { type: string }[] } }>(
          peer,
          instance,
          (body) => body.result.steps.some((s) => s.type === "waitForEvent"),
        );
        expect(
          yield* peer.fetchJson(
            `${instance}/events/approve`,
            json({ approved: true }),
          ),
        ).toMatchObject({ success: true });
        yield* poll<{ result: { status: string; output: unknown } }>(
          peer,
          instance,
          (body) => body.result.status === "complete",
        );
        expect((yield* peer.fetch(instance, { method: "DELETE" })).status).toBe(
          200,
        );
        expect((yield* peer.fetch(instance)).status).toBe(404);
        expect(yield* peer.fetchJson(instances)).toMatchObject({ result: [] });
        // Reuse a deleted ID: cleared actors must not retain old execution state.
        expect(
          yield* peer.fetchJson(
            instances,
            json({ id: "controlled", params: { wait: false } }),
          ),
        ).toMatchObject({ result: { id: "controlled" } });
        expect(
          yield* peer.fetchJson(
            `${instances}/batch/delete`,
            json({ instances: ["controlled"] }),
          ),
        ).toMatchObject({
          result: { deleted: [{ id: "controlled" }], errors: [] },
        });
        expect(yield* peer.fetchJson(instances)).toMatchObject({ result: [] });
        yield* peer.fetch(
          instances,
          json({ id: "rollback", params: { wait: true } }),
        );
        yield* poll<{ result: { steps: { type: string }[] } }>(
          peer,
          `${instances}/rollback`,
          (body) => body.result.steps.some((s) => s.type === "waitForEvent"),
        );
        expect(
          yield* peer.fetchJson(
            `${instances}/rollback/status`,
            json({ action: "terminate", rollback: true }, "PATCH"),
          ),
        ).toMatchObject({ success: true });
        expect(yield* worker.fetchText("/kv?key=rollback")).toBe("completed");
        yield* peer.fetch(
          instances,
          json({ id: "clear-all", params: { wait: true } }),
        );
        expect((yield* peer.fetch(workflow, { method: "DELETE" })).status).toBe(
          200,
        );
        expect(yield* peer.fetchJson(instances)).toMatchObject({ result: [] });
      }),
    { timeout: 90_000 },
  );

  it.effect(
    "paginates captured email from multiple owners without duplicates",
    () =>
      Effect.gen(function* () {
        const mailWorker = (name: string): RuntimeWorker => ({
          ...owner,
          name,
          workflows: [],
          bindings: [SendEmail.local({ binding: "MAIL" })],
        });
        const first = yield* startTestWorker(mailWorker("email-page-first"));
        const second = yield* startTestWorker(mailWorker("email-page-second"));
        yield* poll<{ result: { name: string }[] }>(
          first,
          `${API}/local/workers`,
          (body) => body.result.some((w) => w.name === "email-page-second"),
        );
        const ids: string[] = [];
        for (const worker of [first, second, first, second]) {
          const sent = yield* worker.fetchJson<{ messageId: string }>(
            "/send",
            json({
              from: "sender@example.com",
              to: "recipient@example.com",
              subject: "page",
              text: "body",
            }),
          );
          ids.push(sent.messageId);
        }
        const found: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = yield* first.fetchJson<{
            result: { messageId: string }[];
            result_info: { has_more: boolean; cursor?: string };
          }>(
            `${API}/local/email/sending?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          found.push(...result.result.map((email) => email.messageId));
          if (!result.result_info.has_more) break;
          cursor = result.result_info.cursor;
          expect(cursor).toBeTruthy();
        }
        expect(found.sort()).toEqual(ids.sort());
        expect(
          yield* first.fetchJson(
            `${API}/local/email/sending?worker=unknown-worker`,
          ),
        ).toMatchObject({ result: [] });
      }),
    { timeout: 30_000 },
  );
});
