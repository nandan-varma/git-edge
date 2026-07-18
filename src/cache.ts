/**
 * Generalized parsed-object LRU cache for isomorphic-git.
 *
 * Stores JS values directly — avoids JSON.parse on every hot-path read.
 * Configurable maxSize (bytes estimate via JSON.stringify.length) and TTL.
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
 * `sizeCalculation` uses `JSON.stringify(v).length` as a byte estimate.
 */
export function createParsedObjectCache(
	options?: ParsedObjectCacheOptions,
): ParsedObjectStore {
	const maxSize = options?.maxSize ?? 256 * 1024 * 1024;
	const ttl = options?.ttl ?? 3600 * 1000;

	const cache = new LRUCache<string, object>({
		maxSize,
		sizeCalculation: (v) => JSON.stringify(v).length,
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
