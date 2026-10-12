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
// Each cache retains every packfile it has read, in full. Bound the number of
// repos held so a long-lived process serving many repos doesn't grow without
// limit; least-recently-used repos are dropped first (Map keeps insertion
// order, and a hit re-inserts its key at the end).
const MAX_REPO_CACHES = 32;
const repoCaches = new Map<string, object>();

export function getRepoCache(ownerKey: string, repoName: string): object {
	const key = `${ownerKey}/${repoName}`;
	let cache = repoCaches.get(key);
	if (cache) {
		repoCaches.delete(key);
	} else {
		cache = {};
		if (repoCaches.size >= MAX_REPO_CACHES) {
			const oldest = repoCaches.keys().next().value;
			if (oldest !== undefined) repoCaches.delete(oldest);
		}
	}
	repoCaches.set(key, cache);
	return cache;
}

export function invalidateRepoCache(ownerKey: string, repoName: string): void {
	repoCaches.delete(`${ownerKey}/${repoName}`);
}
