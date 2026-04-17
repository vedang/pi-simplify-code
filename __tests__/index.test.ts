import { describe, expect, it } from "vitest";
import {
  getProjectConfigPath,
  parseSimplifyModeCommand,
  resolveEffectiveConfig,
} from "../src/index.ts";

describe("simplify-code config helpers", () => {
  it("stores project config under cwd .pi/extensions", () => {
    expect(getProjectConfigPath("/repo")).toEqual({
      dir: "/repo/.pi/extensions",
      path: "/repo/.pi/extensions/simplify-code.json",
    });
  });

  it("merges config with project taking precedence", () => {
    expect(resolveEffectiveConfig({ mode: "no" }, { mode: "ask" })).toEqual({
      mode: "ask",
    });
  });

  it("treats bare mode commands as global", () => {
    expect(parseSimplifyModeCommand("/simplify-code yes")).toEqual({
      scope: "global",
      mode: "yes",
    });
  });

  it("supports explicit project-scoped mode commands", () => {
    expect(parseSimplifyModeCommand("/simplify-code project ask")).toEqual({
      scope: "project",
      mode: "ask",
    });
  });
});
