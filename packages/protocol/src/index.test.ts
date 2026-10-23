import { describe, expect, it } from "vitest";
import { PROTOCOL_API_LEVEL } from "./index.js";

describe("@junior/protocol scaffold", () => {
  it("resolves the NodeNext-style relative import and exports the stub", () => {
    expect(PROTOCOL_API_LEVEL).toBe(0);
  });
});
