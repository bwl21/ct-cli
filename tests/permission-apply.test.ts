import { describe, it, expect, vi } from "vitest";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { CtApiError } from "../src/api/ctClient.js";

describe("applyPermissionPlan", () => {
  it("PUTs each grant and DELETEs each removed tuple with the array dataId body", async () => {
    const request = vi.fn(async () => ({}));
    const res = await applyPermissionPlan([{
      key: "t", domainType: "group_type_role", domainId: 8,
      diff: {
        toPut: [{ authId: 1104, dataId: [42], type: "grant" }, { authId: 1101, dataId: [], type: "grant" }],
        toDelete: [{ authId: 2000, dataId: [], type: "grant" }],
        preserved: [], preservedUnknown: [],
      },
    }], { request } as never);
    expect(res).toEqual({ granted: 2, deleted: 1, failed: [] });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", { authId: 1104, dataId: [42], type: "grant" });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", { authId: 1101, type: "grant" }); // no dataId when unscoped
    expect(request).toHaveBeenCalledWith("DELETE", "/permissions/group_type_role/8", { authId: 2000, type: "grant" });
  });

  it("collects a failed write instead of aborting the batch, and keeps writing the rest (#35 items 3+14)", async () => {
    // With concurrency, a mid-batch throw must not stop the others — it is captured in `failed` so the
    // command can print a clean resumable summary rather than a raw stack.
    const request = vi.fn(async (_m: string, _p: string, b: Record<string, unknown>) => {
      if (b.authId === 1104) throw new Error("boom");
      return {};
    });
    const res = await applyPermissionPlan([{
      key: "t", domainType: "group_type_role", domainId: 8,
      diff: {
        toPut: [
          { authId: 1104, dataId: [42], type: "grant" },
          { authId: 1101, dataId: [], type: "grant" },
        ],
        toDelete: [{ authId: 2000, dataId: [], type: "grant" }],
        preserved: [], preservedUnknown: [],
      },
    }], { request } as never);
    expect(res.granted).toBe(1); // only the 1101 PUT succeeded
    expect(res.deleted).toBe(1);
    expect(res.failed).toEqual([
      { method: "PUT", path: "/permissions/group_type_role/8", authId: 1104, dataId: [42], message: "boom" },
    ]);
    // Every op was still attempted despite the failure.
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("renders a CtApiError's HTTP status + body in a failed write's message, via the shared formatter (#71)", async () => {
    const request = vi.fn(async () => {
      throw new CtApiError("PUT /permissions/group_type_role/8 failed", 403, { message: "no permission" });
    });
    const res = await applyPermissionPlan([{
      key: "t", domainType: "group_type_role", domainId: 8,
      diff: {
        toPut: [{ authId: 1104, dataId: [42], type: "grant" }],
        toDelete: [],
        preserved: [], preservedUnknown: [],
      },
    }], { request } as never);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.message).toContain("HTTP 403");
    expect(res.failed[0]?.message).toContain("no permission");
  });
});
