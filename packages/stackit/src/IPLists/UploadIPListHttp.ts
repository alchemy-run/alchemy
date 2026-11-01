import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIPListHttpBinding } from "./BindingHttp.ts";
import { UploadIPList } from "./UploadIPList.ts";

/**
 * HTTP implementation of {@link UploadIPList}.
 *
 * @layer
 * @provides Stackit.IPLists.UploadIPList
 */
export const UploadIPListHttp = Layer.effect(
  UploadIPList,
  makeIPListHttpBinding({
    tag: "Stackit.IPLists.UploadIPList",
    access: { permissions: ["lb-ip-lists.loadbalancer.get", "lb-ip-lists.loadbalancer.upload"] },
    // The PUT takes the whole list: send the labels it has, so a runtime upload
    // can't drop Alchemy's ownership labels.
    operation: Effect.gen(function* () {
      const getIPList = yield* ipLists.getIPList;
      const uploadIPList = yield* ipLists.uploadIPList;
      return (input: ipLists.UploadIPListRequest) =>
        Effect.gen(function* () {
          if (input.labels !== undefined) return yield* uploadIPList(input);
          const { labels } = yield* getIPList({
            projectId: input.projectId,
            region: input.region,
            name: input.name,
          });
          return yield* uploadIPList({ ...input, labels });
        });
    }),
  }),
);
