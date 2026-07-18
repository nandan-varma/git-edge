import { describe, expect, it } from "vitest";
import { createParsedObjectCache } from "../src/cache.js";

describe("createParsedObjectCache", () => {
	it("stores and retrieves objects", () => {
		const cache = createParsedObjectCache({
			maxSize: 1024 * 1024,
			ttl: 60_000,
		});
		const obj = { type: "commit", message: "test" };
		cache.set("key1", obj);
		expect(cache.get("key1")).toEqual(obj);
	});

	it("returns null for missing keys", () => {
		const cache = createParsedObjectCache();
		expect(cache.get("nonexistent")).toBeNull();
	});

	it("deletes entries", () => {
		const cache = createParsedObjectCache();
		cache.set("key1", { a: 1 });
		cache.delete("key1");
		expect(cache.get("key1")).toBeNull();
	});

	it("invalidates by prefix", () => {
		const cache = createParsedObjectCache();
		cache.set("abc:1", { a: 1 });
		cache.set("abc:2", { a: 2 });
		cache.set("xyz:1", { a: 3 });
		cache.invalidatePrefix("abc:");
		expect(cache.get("abc:1")).toBeNull();
		expect(cache.get("abc:2")).toBeNull();
		expect(cache.get("xyz:1")).toEqual({ a: 3 });
	});

	it("respects TTL", async () => {
		const cache = createParsedObjectCache({ ttl: 50 });
		cache.set("key1", { a: 1 });
		await new Promise((r) => setTimeout(r, 100));
		expect(cache.get("key1")).toBeNull();
	});
});
