import * as certificates from "@distilled.cloud/stackit/certificates";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/**
 * Service id the certificates API needs enabled per project: the spec's
 * `service-enablement` on every operation names the load balancer service.
 */
export const CERTIFICATES_SERVICE_ID = "cloud.stackit.loadbalancer";

/** Certificate names are 1-63 characters of `[0-9a-z-]`, per the spec's pattern. */
const NAME_MAX_LENGTH = 63;

/** Physical name for a certificate. */
export const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: NAME_MAX_LENGTH, lowercase: true });

/** Far beyond any project quota; keeps a server-side paging bug from looping forever. */
const MAX_LIST_PAGES = 100;

/** Every certificate of a project and region, across all pages. */
export const listAllCertificates = (scope: ProjectScope) =>
  Effect.gen(function* () {
    const all: certificates.GetCertificateResponse[] = [];
    let pageId: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = yield* certificates.listCertificates({
        ...scope,
        pageSize: "100",
        ...(pageId !== undefined ? { pageId } : {}),
      });
      all.push(...(response.items ?? []));
      pageId = response.nextPageId === "" ? undefined : response.nextPageId;
      if (pageId === undefined) break;
    }
    return all;
  });

/** `GetCertificate`; `undefined` when the certificate is gone. */
export const getCertificateOrUndefined = (scope: ProjectScope, id: string) =>
  certificates
    .getCertificate({ ...scope, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
