import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, it } from "alchemy-test";

Test.make({ providers: AWS.providers() });

describe("ApiGateway bindings", () => {
  it.skip("placeholder — no runtime bindings for REST v1 in this slice", () => {});
});
