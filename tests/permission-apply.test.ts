import { describe, it, expect, vi } from "vitest";
import { applyPermissionPlan } from "../src/permissions/apply.js";

describe("applyPermissionPlan", () => {
  it("PUTs each grant and DELETEs each removed tuple with the array dataId body", async () => {
    const request = vi.fn(async () => ({}));
    const res = await applyPermissionPlan([{
      key: "t", domainType: "group_type_role", domainId: 8,
      diff: {
        toPut: [{ authId: 1104, dataId: [42], type: "grant" }, { authId: 1101, dataId: [], type: "grant" }],
        toDelete: [{ authId: 2000, dataId: [], type: "grant" }],
      },
    }], { request } as never);
    expect(res).toEqual({ granted: 2, deleted: 1 });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", { authId: 1104, dataId: [42], type: "grant" });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", { authId: 1101, type: "grant" }); // no dataId when unscoped
    expect(request).toHaveBeenCalledWith("DELETE", "/permissions/group_type_role/8", { authId: 2000, type: "grant" });
  });
});
