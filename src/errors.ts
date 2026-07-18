/**
 * Error types for git-edge.
 *
 * Edge-compatible: no node: imports.
 */

/** Base class for all git-edge errors. */
export class GitEdgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitEdgeError";
		Error.captureStackTrace?.(this, this.constructor);
	}
}

/** Thrown when a three-way merge has unresolvable conflicts. */
export class GitMergeConflictError extends GitEdgeError {
	readonly conflictingPaths: string[];

	constructor(conflictingPaths: string[]) {
		super(
			`Merge conflict in ${conflictingPaths.length} file(s): ${conflictingPaths.join(", ")}`,
		);
		this.name = "GitMergeConflictError";
		this.conflictingPaths = conflictingPaths;
	}
}
