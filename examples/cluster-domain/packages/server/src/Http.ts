import * as DomainHttp from "@alchemy.run/domain/Http";
import { CustomerApi } from "@cluster-bank/domain/CustomerApi.api";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

/**
 * The CustomerApi as plain HTTP, so curl and scripts can call it: a command
 * is `POST /<Command>`, a view read is `GET /<View>/<key>`. `/` serves an
 * API reference to try them from a browser, and `/openapi.json` the OpenAPI
 * document.
 */
export const BankHttp = DomainHttp.toHttpApi(CustomerApi, {
  expose: [
    "OpenAccount",
    "DepositMoney",
    "WithdrawMoney",
    "RequestTransfer",
    "AccountSummary.get",
    "TransferStatus.get",
  ],
});

/** The `fetch` every front serves, built once the bank's Layer is provided. */
export const bankFetch = HttpRouter.toHttpEffect(
  Layer.mergeAll(
    HttpApiBuilder.layer(BankHttp.api, { openapiPath: "/openapi.json" }),
    HttpApiScalar.layer(BankHttp.api, { path: "/" }),
  ).pipe(Layer.provide(BankHttp.layer), Layer.provide(Http.Platform)),
);
