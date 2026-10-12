/**
 * Generalized parsed-object LRU cache for isomorphic-git.
 *
 * Stores JS values directly — avoids JSON.parse on every hot-path read.
 * Configurable maxSize (rough byte estimate) and TTL.
 *
 * Edge-compatible: no node: imports.
 */
import { LRUCache } from "lru-cache";

export interface ParsedObjectCacheOptions {
	/** Maximum estimated size in bytes (default: 256 MB). */
	maxSize?: number;
	/** Time-to-live in milliseconds (default: 1 hour). */
	ttl?: number;
}

export interface ParsedObjectStore {
	get<T extends object>(key: string): T | null;
	set<T extends object>(key: string, value: T): void;
	delete(key: string): void;
	/** Delete all keys matching a prefix. */
	invalidatePrefix(prefix: string): void;
}

/**
 * Create a parsed-object cache instance.
 *
 * `key` convention: `"${oid}:${format}"` or any caller-chosen string.
 * `sizeCalculation` walks the value for a rough byte estimate.
 */
// Rough byte estimate without serializing: JSON.stringify on every set
// allocated a full copy of large values (commit logs, trees) and expanded
// byte arrays into decimal text, both on the hot path.
function estimateSize(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (value === null || typeof value !== "object") return 8;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	let size = 0;
	if (Array.isArray(value)) {
		for (const item of value) size += estimateSize(item);
		return size;
	}
	for (const [k, v] of Object.entries(value)) {
		size += k.length + estimateSize(v);
	}
	return size;
}

export function createParsedObjectCache(
	options?: ParsedObjectCacheOptions,
): ParsedObjectStore {
	const maxSize = options?.maxSize ?? 256 * 1024 * 1024;
	const ttl = options?.ttl ?? 3600 * 1000;

	const cache = new LRUCache<string, object>({
		maxSize,
		sizeCalculation: (v) => Math.max(1, estimateSize(v)),
		ttl,
	});

	return {
		get<T extends object>(key: string): T | null {
			return (cache.get(key) as T) ?? null;
		},
		set<T extends object>(key: string, value: T): void {
			cache.set(key, value);
		},
		delete(key: string): void {
			cache.delete(key);
		},
		invalidatePrefix(prefix: string): void {
			for (const k of cache.keys()) {
				if (k.startsWith(prefix)) cache.delete(k);
			}
		},
	};
}
