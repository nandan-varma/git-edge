import { describe, expect, it } from "vitest";
import { getRepoCache } from "../src/repo.js";

describe("getRepoCache", () => {
	it("returns the same cache for the same repo", () => {
		expect(getRepoCache("o", "same")).toBe(getRepoCache("o", "same"));
	});

	it("evicts the least recently used repo past the bound", () => {
		const caches = Array.from({ length: 32 }, (_, i) =>
			getRepoCache("lru", `r${i}`),
		);
		getRepoCache("lru", "r0"); // touch: r1 is now least recently used
		getRepoCache("lru", "overflow");
		expect(getRepoCache("lru", "r0")).toBe(caches[0]);
		expect(getRepoCache("lru", "r1")).not.toBe(caches[1]);
	});
});
