/**
 * Sidecar entry for the dev-mode {@link LocalWebhookProvider} (see
 * `Dev/RpcProvider` — the provider and its running poll loops live in
 * the sidecar process and survive user-code hot reloads). GitHub
 * credentials resolve exactly as `GitHub.providers()` resolves them on
 * the operator's machine: env tokens, the alchemy profile, or `gh`.
 */
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as CliKit from "../Cli/CliKit/index.ts";
import * as RpcServer from "../Dev/RpcServer.ts";
import { makeGitHubAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { LocalWebhookProvider } from "./LocalWebhookProvider.ts";

LocalWebhookProvider().pipe(
  Layer.provide(Credentials.fromAuthProvider()),
  Layer.provide(makeGitHubAuth()),
  Layer.provide(ProfileStoreLive),
  Layer.provide(CredentialsStoreLive),
  // the sidecar has no TTY; auth flows must not prompt
  Layer.provide(CliKit.layer({ input: false })),
  RpcServer.launch,
);
