import * as Lambda from "@/AWS/Lambda";
import * as QApps from "@/AWS/QApps";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * The Q Business application environment instance the gated fixture deploys
 * into. Forwarded into the Lambda's environment so the module composes
 * identically when the runtime re-executes it.
 */
const INSTANCE_ID = process.env.QAPPS_INSTANCE_ID ?? "";

/** Card ids referenced by both the app definition and the runtime routes. */
export const TEXT_CARD_ID = "11111111-1111-4111-8111-111111111111";
export const QUERY_CARD_ID = "22222222-2222-4222-8222-222222222222";
export const FILE_CARD_ID = "33333333-3333-4333-8333-333333333333";

/** `"hello world"` as base64 — the fixture's one-and-only upload payload. */
const HELLO_BASE64 = "aGVsbG8gd29ybGQ=";
/** SHA-256 hex digest of `"hello world"`. */
const HELLO_SHA256 =
  "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

export class QAppsTestFunction extends Lambda.Function<Lambda.Function>()(
  "QAppsTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the gated test asserts on concrete
 * fields for the happy path and accepts a typed tag for the state-dependent
 * edges (verification, exports on empty sessions, permission grants that
 * need Identity Center principals). An untyped error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * Q Apps binding fixture: deploys a real Q App into the Q Business
 * application environment instance named by `QAPPS_INSTANCE_ID` (gated
 * behind AWS_TEST_QAPPS — Q Apps requires IAM Identity Center and a
 * Q Business application) plus a Lambda bound to all 28 Q Apps runtime
 * bindings.
 */
export default QAppsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
    env: { QAPPS_INSTANCE_ID: INSTANCE_ID },
  },
  Effect.gen(function* () {
    const app = yield* QApps.QApp("QAppsBindingsApp", {
      instanceId: INSTANCE_ID,
      description: "alchemy qapps bindings fixture",
      appDefinition: {
        cards: [
          {
            textInput: {
              id: TEXT_CARD_ID,
              title: "Source Text",
              type: "text-input",
            },
          },
          {
            fileUpload: {
              id: FILE_CARD_ID,
              title: "Document",
              type: "file-upload",
            },
          },
          {
            qQuery: {
              id: QUERY_CARD_ID,
              title: "Summary",
              type: "q-query",
              prompt: "Summarize the following text: @Source Text",
            },
          },
        ],
      },
      tags: { fixture: "qapps-bindings" },
    });

    const bound = {
      // sessions
      startQAppSession: yield* QApps.StartQAppSession(app),
      getQAppSession: yield* QApps.GetQAppSession(app),
      getQAppSessionMetadata: yield* QApps.GetQAppSessionMetadata(app),
      updateQAppSession: yield* QApps.UpdateQAppSession(app),
      updateQAppSessionMetadata: yield* QApps.UpdateQAppSessionMetadata(app),
      listQAppSessionData: yield* QApps.ListQAppSessionData(app),
      exportQAppSessionData: yield* QApps.ExportQAppSessionData(app),
      stopQAppSession: yield* QApps.StopQAppSession(app),
      // app-keyed operations
      importDocument: yield* QApps.ImportDocument(app),
      createPresignedUrl: yield* QApps.CreatePresignedUrl(app),
      associateQAppWithUser: yield* QApps.AssociateQAppWithUser(app),
      disassociateQAppFromUser: yield* QApps.DisassociateQAppFromUser(app),
      describeQAppPermissions: yield* QApps.DescribeQAppPermissions(app),
      updateQAppPermissions: yield* QApps.UpdateQAppPermissions(app),
      // instance-level operations
      listQApps: yield* QApps.ListQApps(app),
      predictQApp: yield* QApps.PredictQApp(app),
      listCategories: yield* QApps.ListCategories(app),
      batchCreateCategory: yield* QApps.BatchCreateCategory(app),
      batchUpdateCategory: yield* QApps.BatchUpdateCategory(app),
      batchDeleteCategory: yield* QApps.BatchDeleteCategory(app),
      // library items
      createLibraryItem: yield* QApps.CreateLibraryItem(app),
      getLibraryItem: yield* QApps.GetLibraryItem(app),
      listLibraryItems: yield* QApps.ListLibraryItems(app),
      updateLibraryItem: yield* QApps.UpdateLibraryItem(app),
      updateLibraryItemMetadata: yield* QApps.UpdateLibraryItemMetadata(app),
      deleteLibraryItem: yield* QApps.DeleteLibraryItem(app),
      associateLibraryItemReview: yield* QApps.AssociateLibraryItemReview(app),
      disassociateLibraryItemReview:
        yield* QApps.DisassociateLibraryItemReview(app),
    };

    const AppVersion = yield* app.appVersion;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const sessionId = url.searchParams.get("sid") ?? "";
        const itemId = url.searchParams.get("item") ?? "";
        const categoryId = url.searchParams.get("id") ?? "";

        if (pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // --- sessions -----------------------------------------------------
        if (pathname === "/session/start") {
          const result = yield* errorTagged(
            bound.startQAppSession({
              appVersion: yield* AppVersion,
              initialValues: [{ cardId: TEXT_CARD_ID, value: "hello world" }],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { sessionId: result.sessionId },
          );
        }
        if (pathname === "/session/get") {
          const result = yield* errorTagged(
            bound.getQAppSession({ sessionId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { sessionId: result.sessionId, status: result.status },
          );
        }
        if (pathname === "/session/metadata") {
          const result = yield* errorTagged(
            bound.getQAppSessionMetadata({ sessionId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  sessionId: result.sessionId,
                  sharingEnabled: result.sharingConfiguration.enabled,
                },
          );
        }
        if (pathname === "/session/update") {
          const result = yield* errorTagged(
            bound.updateQAppSession({
              sessionId,
              values: [{ cardId: TEXT_CARD_ID, value: "updated text" }],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { sessionId: result.sessionId },
          );
        }
        if (pathname === "/session/update-metadata") {
          const result = yield* errorTagged(
            bound.updateQAppSessionMetadata({
              sessionId,
              sessionName: "alchemy bindings session",
              sharingConfiguration: { enabled: false },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { sessionId: result.sessionId },
          );
        }
        if (pathname === "/session/data") {
          const result = yield* errorTagged(
            bound.listQAppSessionData({ sessionId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.sessionData?.length ?? 0 },
          );
        }
        if (pathname === "/session/export") {
          const result = yield* errorTagged(
            bound.exportQAppSessionData({ sessionId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { csvFileLink: result.csvFileLink },
          );
        }
        if (pathname === "/session/stop") {
          const result = yield* errorTagged(
            bound.stopQAppSession({ sessionId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { stopped: true },
          );
        }

        // --- app-keyed operations ------------------------------------------
        if (pathname === "/import-document") {
          const result = yield* errorTagged(
            bound.importDocument({
              cardId: FILE_CARD_ID,
              fileContentsBase64: HELLO_BASE64,
              fileName: "hello.txt",
              scope: "SESSION",
              sessionId,
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { fileId: result.fileId },
          );
        }
        if (pathname === "/presigned-url") {
          const result = yield* errorTagged(
            bound.createPresignedUrl({
              cardId: FILE_CARD_ID,
              fileContentsSha256: HELLO_SHA256,
              fileName: "hello.txt",
              scope: "SESSION",
              sessionId,
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { fileId: result.fileId, presignedUrl: result.presignedUrl },
          );
        }
        if (pathname === "/favorite") {
          const result = yield* errorTagged(bound.associateQAppWithUser());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { favorited: true },
          );
        }
        if (pathname === "/unfavorite") {
          const result = yield* errorTagged(bound.disassociateQAppFromUser());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { unfavorited: true },
          );
        }
        if (pathname === "/permissions") {
          const result = yield* errorTagged(bound.describeQAppPermissions());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  appId: result.appId,
                  count: result.permissions?.length ?? 0,
                },
          );
        }
        if (pathname === "/permissions/update") {
          // No Identity Center principal is available to grant to — an empty
          // update proves the wiring; a typed rejection is acceptable.
          const result = yield* errorTagged(bound.updateQAppPermissions({}));
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { appId: result.appId },
          );
        }

        // --- instance-level operations --------------------------------------
        if (pathname === "/list-apps") {
          const result = yield* errorTagged(bound.listQApps({}));
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { count: result.apps?.length ?? 0 },
          );
        }
        if (pathname === "/predict") {
          const result = yield* errorTagged(
            bound.predictQApp({
              options: {
                problemStatement:
                  "Summarize meeting notes into a list of action items",
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { title: result.app.title },
          );
        }

        // --- categories -----------------------------------------------------
        if (pathname === "/category/create") {
          const result = yield* errorTagged(
            bound.batchCreateCategory({
              categories: [{ id: categoryId, title: "AlchemyBindings" }],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { created: true },
          );
        }
        if (pathname === "/categories") {
          const result = yield* errorTagged(bound.listCategories({}));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  count: result.categories?.length ?? 0,
                  ids: result.categories?.map((c) => c.id) ?? [],
                },
          );
        }
        if (pathname === "/category/update") {
          const result = yield* errorTagged(
            bound.batchUpdateCategory({
              categories: [{ id: categoryId, title: "AlchemyBindings2" }],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { updated: true },
          );
        }
        if (pathname === "/category/delete") {
          const result = yield* errorTagged(
            bound.batchDeleteCategory({ categories: [categoryId] }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { deleted: true },
          );
        }

        // --- library items ----------------------------------------------------
        if (pathname === "/library/create") {
          const result = yield* errorTagged(
            bound.createLibraryItem({
              appVersion: yield* AppVersion,
              categories: [],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { libraryItemId: result.libraryItemId, status: result.status },
          );
        }
        if (pathname === "/library/get") {
          const result = yield* errorTagged(
            bound.getLibraryItem({ libraryItemId: itemId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  libraryItemId: result.libraryItemId,
                  ratingCount: result.ratingCount,
                },
          );
        }
        if (pathname === "/library/list") {
          const result = yield* errorTagged(bound.listLibraryItems({}));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.libraryItems?.length ?? 0 },
          );
        }
        if (pathname === "/library/update") {
          const result = yield* errorTagged(
            bound.updateLibraryItem({
              libraryItemId: itemId,
              status: "DISABLED",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { status: result.status },
          );
        }
        if (pathname === "/library/verify") {
          const result = yield* errorTagged(
            bound.updateLibraryItemMetadata({
              libraryItemId: itemId,
              isVerified: true,
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { verified: true },
          );
        }
        if (pathname === "/library/review") {
          const result = yield* errorTagged(
            bound.associateLibraryItemReview({ libraryItemId: itemId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { reviewed: true },
          );
        }
        if (pathname === "/library/unreview") {
          const result = yield* errorTagged(
            bound.disassociateLibraryItemReview({ libraryItemId: itemId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { unreviewed: true },
          );
        }
        if (pathname === "/library/delete") {
          const result = yield* errorTagged(
            bound.deleteLibraryItem({ libraryItemId: itemId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { deleted: true },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        QApps.StartQAppSessionHttp,
        QApps.GetQAppSessionHttp,
        QApps.GetQAppSessionMetadataHttp,
        QApps.UpdateQAppSessionHttp,
        QApps.UpdateQAppSessionMetadataHttp,
        QApps.ListQAppSessionDataHttp,
        QApps.ExportQAppSessionDataHttp,
        QApps.StopQAppSessionHttp,
        QApps.ImportDocumentHttp,
        QApps.CreatePresignedUrlHttp,
        QApps.AssociateQAppWithUserHttp,
        QApps.DisassociateQAppFromUserHttp,
        QApps.DescribeQAppPermissionsHttp,
        QApps.UpdateQAppPermissionsHttp,
        QApps.ListQAppsHttp,
        QApps.PredictQAppHttp,
        QApps.ListCategoriesHttp,
        QApps.BatchCreateCategoryHttp,
        QApps.BatchUpdateCategoryHttp,
        QApps.BatchDeleteCategoryHttp,
        QApps.CreateLibraryItemHttp,
        QApps.GetLibraryItemHttp,
        QApps.ListLibraryItemsHttp,
        QApps.UpdateLibraryItemHttp,
        QApps.UpdateLibraryItemMetadataHttp,
        QApps.DeleteLibraryItemHttp,
        QApps.AssociateLibraryItemReviewHttp,
        QApps.DisassociateLibraryItemReviewHttp,
      ),
    ),
  ),
);
