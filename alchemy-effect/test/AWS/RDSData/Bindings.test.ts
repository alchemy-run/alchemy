import { describe, test } from "vitest";

describe("RDSData Bindings", () => {
  describe("ExecuteStatement", () => {
    test.skip("executes a bound statement against Aurora", () => {});
  });

  describe("BatchExecuteStatement", () => {
    test.skip("executes a bound batch statement against Aurora", () => {});
  });

  describe("BeginTransaction", () => {
    test.skip("starts a bound Aurora Data API transaction", () => {});
  });

  describe("CommitTransaction", () => {
    test.skip("commits a bound Aurora Data API transaction", () => {});
  });

  describe("ExecuteSql", () => {
    test.skip("executes the deprecated bound ExecuteSql API", () => {});
  });

  describe("RollbackTransaction", () => {
    test.skip("rolls back a bound Aurora Data API transaction", () => {});
  });
});
