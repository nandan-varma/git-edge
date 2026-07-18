/**
 * Repository management utilities.
 *
 * Edge-compatible helpers for isomorphic-git repos: bare repo init,
 * packfile-only disk usage, and isomorphic-git cache management.
 *
 * No node: imports. The `fs` parameter is caller-provided.
 */

import type { FsClient } from "isomorphic-git";
import git from "isomorphic-git";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The repo fs+gitdir shape used by isomorphic-git. */
export interface Repo {
	fs: FsClient;
	gitdir: string;
	cache?: object;
}

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

// ---------------------------------------------------------------------------
// Repo init
// ---------------------------------------------------------------------------

/**
 * Initialize a new bare git repository.
 *
 * Accepts any fs implementation — works with node:fs, S3-backed fs,
 * or any isomorphic-git-compatible filesystem.
 *
 * Returns the gitdir path.
 */
export async function initBareRepo(
	repo: Repo,
	defaultBranch: string = "main",
): Promise<void> {
	await git.init({
		...repo,
		dir: repo.gitdir,
		defaultBranch,
		bare: true,
	});
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

/**
 * Estimate the disk usage of a bare repo's git objects.
 *
 * This walks the loose object directories and reads `.pack` file sizes
 * from the `objects/` directory. For S3-backed repos, this may be
 * expensive — prefer tracking size at write time if possible.
 *
 * The caller must provide a `stat` function that works with their fs.
 * For node:fs this is `fs.stat`; for edge runtimes it may be a HEAD
 * request to the S3 object.
 */
export async function estimateRepoSize(
	repo: Repo,
	stat: (path: string) => Promise<{ size: number }>,
	list: (path: string) => Promise<string[]>,
): Promise<number> {
	let total = 0;

	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await list(dir);
		} catch {
			return;
		}

		const sizes = await Promise.all(
			entries.map(async (name) => {
				const fullPath = `${dir}/${name}`;
				try {
					const s = await stat(fullPath);
					return s.size;
				} catch {
					return 0;
				}
			}),
		);

		for (const size of sizes) total += size;
	}

	await walk(`${repo.gitdir}/objects`);
	return total;
}
