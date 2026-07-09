import { describe, it, expect } from "vitest";
import { formatError } from "../src/ui.js";
import { CtApiError } from "../src/api/ctClient.js";

describe("formatError (#50)", () => {
  it("renders a plain Error's message unchanged", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("renders a non-Error thrown value via String()", () => {
    expect(formatError("boom")).toBe("boom");
  });

  it("includes the HTTP status and a JSON response body for CtApiError", () => {
    const err = new CtApiError("GET /groups?limit=500 failed", 400, { errors: ["limit exceeds max of 100"] });
    const rendered = formatError(err);
    expect(rendered).toContain("400");
    expect(rendered).toContain("limit exceeds max of 100");
  });

  it("includes a plain-string response body verbatim", () => {
    const err = new CtApiError("GET /groups failed", 500, "internal server error");
    const rendered = formatError(err);
    expect(rendered).toContain("500");
    expect(rendered).toContain("internal server error");
  });

  it("truncates very large response bodies instead of dumping them whole", () => {
    const big = "x".repeat(5000);
    const err = new CtApiError("GET /groups failed", 500, big);
    const rendered = formatError(err);
    expect(rendered.length).toBeLessThan(big.length);
    expect(rendered).toContain("truncated");
  });

  it("omits a body section when there is no body", () => {
    const err = new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    const rendered = formatError(err);
    expect(rendered).toContain("401");
    expect(rendered).not.toContain("null");
  });
});
