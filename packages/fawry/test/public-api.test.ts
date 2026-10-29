/**
 * Public API guard. Adding, renaming or removing an export changes this snapshot, so the change
 * shows up in review. If it is intentional: `pnpm vitest run -u` and add a changeset
 * (removing or renaming an export is a breaking change → major bump).
 */
import { describe, expect, it } from "vitest";
import * as index from "../src/index.js";
import * as testing from "../src/testing.js";

describe("public exports", () => {
  it("@sarrafjs/fawry", () => {
    expect(Object.keys(index).sort()).toMatchSnapshot();
  });
  it("@sarrafjs/fawry/testing", () => {
    expect(Object.keys(testing).sort()).toMatchSnapshot();
  });
});
