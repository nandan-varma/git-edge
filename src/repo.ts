/**
 * isomorphic-git per-repo parse cache management.
 *
 * No node: imports.
 */

// ---------------------------------------------------------------------------
// isomorphic-git cache management
// ---------------------------------------------------------------------------

/**
 * Per-repo isomorphic-git packfile cache.
 *
 * isomorphic-git re-parses a packfile index from scratch on every
 * readTree/log/readObject call unless callers share a `cache` object
 * across calls. Without this, operations that touch many objects
 * (e.g. walking commit history) pay that parse cost hundreds of times.
 * Objects are content-addressed/immutable so a long-lived per-repo
 * cache is safe.
 */
const repoCaches = new Map<string, object>();

export function getRepoCache(ownerKey: string, repoName: string): object {
	const key = `${ownerKey}/${repoName}`;
	let cache = repoCaches.get(key);
	if (!cache) {
		cache = {};
		repoCaches.set(key, cache);
	}
	return cache;
}

export function invalidateRepoCache(ownerKey: string, repoName: string): void {
	repoCaches.delete(`${ownerKey}/${repoName}`);
}
