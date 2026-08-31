/**
 * git-edge
 *
 * High-level edge-compatible git operations.
 * Composes with git-fs-s3 for storage.
 */

export {
	createParsedObjectCache,
	type ParsedObjectCacheOptions,
	type ParsedObjectStore,
} from "./cache.js";
export {
	GitEdgeError,
	GitMergeConflictError,
} from "./errors.js";
export {
	type MergeOpts,
	type MergeResult,
	type Repo,
	threeWayMerge,
} from "./merge.js";
export { getRepoCache, invalidateRepoCache } from "./repo.js";
