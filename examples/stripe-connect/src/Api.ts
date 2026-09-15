import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./database.ts";

interface ConnectedAccountRow {
  id: string;
  email: string;
  created_at: number;
}

/**
 * A Worker that onboards a merchant onto Stripe Connect.
 *
 * `POST /onboard` creates an Express account, records it in D1, and
 * returns an Account Link URL for hosted onboarding. `GET /accounts/:id`
 * reads the recorded account back.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const createAccount = yield* Stripe.CreateAccount();
    const createAccountLink = yield* Stripe.CreateAccountLink();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "POST" && url.pathname === "/onboard") {
          const body = (yield* request.json) as { email?: string };
          if (!body.email) {
            return yield* HttpServerResponse.json(
              { error: "email is required" },
              { status: 400 },
            );
          }

          const account = yield* createAccount({
            type: "express",
            country: "US",
            email: body.email,
          }).pipe(Effect.orDie);

          yield* db
            .prepare(
              "INSERT INTO connected_accounts (id, email) VALUES (?, ?)",
            )
            .bind(account.id, body.email)
            .run()
            .pipe(Effect.orDie);

          const link = yield* createAccountLink({
            account: account.id,
            type: "account_onboarding",
            return_url: `${url.origin}/onboarded`,
          }).pipe(Effect.orDie);

          return yield* HttpServerResponse.json(
            { accountId: account.id, onboardingUrl: link.url },
            { status: 201 },
          );
        }

        if (request.method === "GET" && url.pathname === "/onboarded") {
          return HttpServerResponse.text(
            "Onboarding complete. You can close this tab.",
          );
        }

        if (request.method === "GET" && url.pathname.startsWith("/accounts/")) {
          const id = url.pathname.slice("/accounts/".length);
          const row = yield* db
            .prepare(
              "SELECT id, email, created_at FROM connected_accounts WHERE id = ?",
            )
            .bind(id)
            .first<ConnectedAccountRow>()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ account: row ?? null });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Stripe.CreateAccountHttp,
      Stripe.CreateAccountLinkHttp,
    ]),
  ),
) {}
