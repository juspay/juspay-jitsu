import { describe, expect, it } from "vitest";
import { applyBasePath, removeBasePath } from "../../lib/base-path";

describe("applyBasePath", () => {
  it("prefixes same-origin absolute paths", () => {
    expect(applyBasePath("/", "/jitsu")).toBe("/jitsu/");
    expect(applyBasePath("/api/app-config?refresh=true", "/jitsu")).toBe("/jitsu/api/app-config?refresh=true");
  });

  it("does not prefix a path twice", () => {
    expect(applyBasePath("/jitsu", "/jitsu")).toBe("/jitsu");
    expect(applyBasePath("/jitsu/api/app-config", "/jitsu")).toBe("/jitsu/api/app-config");
  });

  it("leaves external, protocol-relative, and relative URLs unchanged", () => {
    expect(applyBasePath("https://example.com/api", "/jitsu")).toBe("https://example.com/api");
    expect(applyBasePath("//example.com/api", "/jitsu")).toBe("//example.com/api");
    expect(applyBasePath("api/app-config", "/jitsu")).toBe("api/app-config");
  });

  it("is a no-op when no base path is configured", () => {
    expect(applyBasePath("/api/app-config", "")).toBe("/api/app-config");
  });
});

describe("removeBasePath", () => {
  it("removes the configured prefix before Next Router navigation", () => {
    expect(removeBasePath("/jitsu", "/jitsu")).toBe("/");
    expect(removeBasePath("/jitsu/workspaces?tab=all", "/jitsu")).toBe("/workspaces?tab=all");
    expect(removeBasePath("/jitsu?tab=all", "/jitsu")).toBe("/?tab=all");
    expect(removeBasePath("/jitsu#section", "/jitsu")).toBe("/#section");
  });

  it("does not alter unrelated paths", () => {
    expect(removeBasePath("/workspaces", "/jitsu")).toBe("/workspaces");
    expect(removeBasePath("/jitsu-other", "/jitsu")).toBe("/jitsu-other");
  });
});
