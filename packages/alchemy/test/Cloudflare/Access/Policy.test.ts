import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import { Provider as ProviderService } from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import { ACCOUNT_ID, session, stubCloudflare, type StubCall } from "../StubCloudflare.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create and delete basic allow policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("BasicAllowPolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
        }),
      );

      expect(policy.policyId).toBeDefined();
      expect(policy.decision).toEqual("allow");
      expect(policy.accountId).toEqual(accountId);

      const actual = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: policy.policyId,
      });
      expect(actual.id).toEqual(policy.policyId);
      expect(actual.decision).toEqual("allow");
      expect(actual.include?.length).toEqual(1);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessPolicy({ accountId, policyId: policy.policyId })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "update mutates includes without replacing",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("UpdatePolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
            adopt: true,
          });
        }),
      );

      expect(initial.policyId).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("UpdatePolicy", {
            decision: "allow",
            include: [
              { emailDomain: { domain: "example.com" } },
              { emailDomain: { domain: "test.example.com" } },
            ],
            adopt: true,
          });
        }),
      );

      expect(updated.policyId).toEqual(initial.policyId);

      const actual = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: updated.policyId,
      });
      expect(actual.include?.length).toEqual(2);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "adopts an out-of-band reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = "alchemy-access-policy-adopt-test";

      yield* stack.destroy();

      // Pre-create the policy out of band so adoption has something to find.
      const preExisting = yield* zeroTrust.createAccessPolicy({
        accountId,
        name,
        decision: "allow",
        include: [{ emailDomain: { domain: "example.com" } }],
      });
      expect(preExisting.id).toBeDefined();

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("AdoptPolicy", {
            name,
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
            adopt: true,
          });
        }),
      );

      expect(adopted.policyId).toEqual(preExisting.id);
      expect(adopted.accountId).toEqual(accountId);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessPolicy({ accountId, policyId: preExisting.id! })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "list enumerates the deployed reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("ListPolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Access.Policy);
      const all = yield* provider.list();

      const match = all.find((p) => p.policyId === policy.policyId);
      expect(match).toBeDefined();
      expect(match?.accountId).toEqual(accountId);
      expect(match?.decision).toEqual("allow");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "connection rules and approval settings round-trip through create and update",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = (usernames: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Policy("SshPolicy", {
              decision: "allow",
              include: [{ emailDomain: "example.com" }],
              connectionRules: {
                ssh: { usernames, allowEmailAlias: true },
                rdp: { allowedClipboardLocalToRemoteFormats: ["text"] },
              },
              isolationRequired: false,
              purposeJustificationRequired: true,
              purposeJustificationPrompt: "Why do you need access?",
            });
          }),
        );

      const created = yield* deploy(["root"]);
      const live1 = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: created.policyId,
      });
      expect(live1.connectionRules?.ssh?.usernames).toEqual(["root"]);
      expect(live1.connectionRules?.ssh?.allowEmailAlias).toBe(true);
      expect(live1.connectionRules?.rdp?.allowedClipboardLocalToRemoteFormats).toEqual(["text"]);
      expect(live1.purposeJustificationPrompt).toEqual("Why do you need access?");

      const updated = yield* deploy(["root", "ubuntu"]);
      expect(updated.policyId).toEqual(created.policyId);
      const live2 = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: updated.policyId,
      });
      expect(live2.connectionRules?.ssh?.usernames).toEqual(["root", "ubuntu"]);
      expect(live2.purposeJustificationRequired).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "adopted policy keeps the live fields it does not declare",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = "alchemy-access-policy-preserve-test";

      yield* stack.destroy();

      const existing = yield* zeroTrust.createAccessPolicy({
        accountId,
        name,
        decision: "allow",
        include: [{ emailDomain: { domain: "example.com" } }],
        exclude: [{ email: { email: "intern@example.com" } }],
        require: [{ geo: { countryCode: "US" } }],
        approvalRequired: true,
        approvalGroups: [{ approvalsNeeded: 1, emailAddresses: ["lead@example.com"] }],
        purposeJustificationRequired: true,
        purposeJustificationPrompt: "Ticket number?",
      });

      const deploy = (props: Partial<Cloudflare.Access.PolicyProps>) =>
        stack.deploy(
          Cloudflare.Access.Policy("PreservePolicy", {
            name,
            decision: "allow",
            include: [{ emailDomain: "example.com" }],
            adopt: true,
            ...props,
          }),
        );
      const live = () => zeroTrust.getAccessPolicy({ accountId, policyId: existing.id! });

      // Only sessionDuration is declared; every other live field survives the PUT.
      const adopted = yield* deploy({ sessionDuration: "12h" });
      expect(adopted.policyId).toEqual(existing.id);
      const kept = yield* live();
      expect(kept.sessionDuration).toEqual("12h");
      expect(kept.exclude).toEqual([{ email: { email: "intern@example.com" } }]);
      expect(kept.require).toEqual([{ geo: { countryCode: "US" } }]);
      expect(kept.approvalRequired).toBe(true);
      expect(kept.approvalGroups?.[0]?.emailAddresses).toEqual(["lead@example.com"]);
      expect(kept.purposeJustificationRequired).toBe(true);
      expect(kept.purposeJustificationPrompt).toEqual("Ticket number?");

      // Explicit `[]` / `false` still clear.
      yield* deploy({ sessionDuration: "12h", require: [], approvalRequired: false });
      const cleared = yield* live();
      expect(cleared.require ?? []).toEqual([]);
      expect(cleared.approvalRequired ?? false).toBe(false);
      expect(cleared.exclude).toEqual([{ email: { email: "intern@example.com" } }]);

      yield* stack.destroy();

      const afterDestroy = yield* live().pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

const POLICY_ID = "policy-1";

const livePolicy = (overrides: Record<string, unknown> = {}) => ({
  id: POLICY_ID,
  name: "ssh-ops",
  decision: "allow",
  include: [{ email_domain: { domain: "example.com" } }],
  exclude: [],
  require: [],
  reusable: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const sshProps: Cloudflare.Access.PolicyProps = {
  name: "ssh-ops",
  decision: "allow",
  include: [{ emailDomain: "example.com" }],
  connectionRules: {
    ssh: { usernames: ["root", "ubuntu"], allowEmailAlias: true },
    rdp: {
      allowedClipboardLocalToRemoteFormats: ["text"],
      allowedClipboardRemoteToLocalFormats: ["text", "file"],
    },
  },
  approvalRequired: true,
  approvalGroups: [{ approvalsNeeded: 1, emailAddresses: ["lead@example.com"] }],
  isolationRequired: true,
  purposeJustificationRequired: true,
  purposeJustificationPrompt: "Ticket number?",
  mfaConfig: { allowedAuthenticators: ["totp"], sessionDuration: "12h" },
};

const sshWire = {
  connection_rules: {
    ssh: { usernames: ["root", "ubuntu"], allow_email_alias: true },
    rdp: {
      allowed_clipboard_local_to_remote_formats: ["text"],
      allowed_clipboard_remote_to_local_formats: ["text", "file"],
    },
  },
  approval_required: true,
  approval_groups: [{ approvals_needed: 1, email_addresses: ["lead@example.com"] }],
  isolation_required: true,
  purpose_justification_required: true,
  purpose_justification_prompt: "Ticket number?",
  mfa_config: { allowed_authenticators: ["totp"], session_duration: "12h" },
};

const reconcilePolicy = (
  output: Cloudflare.Access.Policy["Attributes"] | undefined,
  respond: (call: StubCall) => unknown,
  news: Cloudflare.Access.PolicyProps = sshProps,
) =>
  Effect.gen(function* () {
    const stub = stubCloudflare(respond);
    const attrs = yield* Effect.gen(function* () {
      const provider = yield* ProviderService<Cloudflare.Access.Policy>("Cloudflare.Access.Policy");
      return yield* provider.reconcile({
        id: "SshOps",
        fqn: "SshOps",
        instanceId: "0123456789abcdef0123456789abcdef",
        news,
        olds: output === undefined ? undefined : news,
        output,
        bindings: [] as never,
        session,
      });
    }).pipe(Effect.provide(Cloudflare.Access.PolicyProvider()), Effect.provide(stub.layer));
    return { attrs, calls: stub.calls };
  });

describe(
  "Policy wire body (offline)",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:access", "local"],
  },
  () => {
    it.effect("create sends connection rules and approval settings", () =>
      Effect.gen(function* () {
        const { attrs, calls } = yield* reconcilePolicy(undefined, (call) =>
          call.method === "GET" ? [] : livePolicy(call.body),
        );

        const create = calls.find((c) => c.method === "POST");
        expect(create?.path).toEqual(`/accounts/${ACCOUNT_ID}/access/policies`);
        expect(create?.body).toMatchObject({
          name: "ssh-ops",
          decision: "allow",
          include: [{ email_domain: { domain: "example.com" } }],
          ...sshWire,
        });
        expect(attrs.policyId).toEqual(POLICY_ID);
      }),
    );

    it.effect("update keeps connection rules in the PUT", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcilePolicy(
          {
            policyId: POLICY_ID,
            name: "ssh-ops",
            decision: "allow",
            accountId: ACCOUNT_ID,
            createdAt: undefined,
            updatedAt: undefined,
          },
          (call) =>
            call.method === "GET" ? livePolicy(sshWire) : livePolicy({ ...sshWire, ...call.body }),
        );

        const update = calls.find((c) => c.method === "PUT");
        expect(update?.path).toEqual(`/accounts/${ACCOUNT_ID}/access/policies/${POLICY_ID}`);
        expect(update?.body).toMatchObject(sshWire);
        expect(calls.some((c) => c.method === "POST")).toBe(false);
      }),
    );

    it.effect("update sends live values for omitted fields and honors explicit clears", () =>
      Effect.gen(function* () {
        const { calls } = yield* reconcilePolicy(
          {
            policyId: POLICY_ID,
            name: "ssh-ops",
            decision: "allow",
            accountId: ACCOUNT_ID,
            createdAt: undefined,
            updatedAt: undefined,
          },
          (call) =>
            call.method === "GET"
              ? livePolicy({ ...sshWire, require: [{ geo: { country_code: "US" } }] })
              : livePolicy(call.body),
          {
            name: "ssh-ops",
            decision: "allow",
            include: [{ emailDomain: "example.com" }],
            sessionDuration: "12h",
            approvalRequired: false,
            exclude: [],
          },
        );

        const update = calls.find((c) => c.method === "PUT");
        expect(update?.body).toMatchObject({
          ...sshWire,
          session_duration: "12h",
          approval_required: false,
          exclude: [],
          require: [{ geo: { country_code: "US" } }],
        });
      }),
    );

    it.effect("ssh connection rules survive decoding", () =>
      Effect.gen(function* () {
        const stub = stubCloudflare(() => livePolicy(sshWire));
        const policy = yield* zeroTrust
          .getAccessPolicy({ accountId: ACCOUNT_ID, policyId: POLICY_ID })
          .pipe(Effect.provide(stub.layer));

        expect(policy.connectionRules?.ssh).toEqual({
          usernames: ["root", "ubuntu"],
          allowEmailAlias: true,
        });
      }),
    );
  },
);
