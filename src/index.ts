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
	analyzeMerge,
	type MergeAnalysis,
	type MergeOpts,
	type MergeResult,
	type Repo,
	threeWayMerge,
} from "./merge.js";
export {
	estimateRepoSize,
	getRepoCache,
	initBareRepo,
	invalidateRepoCache,
} from "./repo.js";
