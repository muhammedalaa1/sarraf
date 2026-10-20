/**
 * Public API guard. Adding, renaming or removing an export changes this snapshot, so the change
 * shows up in review. If it is intentional: `pnpm vitest run -u` and add a changeset
 * (removing or renaming an export is a breaking change → major bump).
 */
import { describe, expect, it } from "vitest";
import * as redis from "../src/idempotency/redis.js";
import * as index from "../src/index.js";

describe("public exports", () => {
  it("@sarraf/core", () => {
    expect(Object.keys(index).sort()).toMatchSnapshot();
  });
  it("@sarraf/core/redis", () => {
    expect(Object.keys(redis).sort()).toMatchSnapshot();
  });
});
