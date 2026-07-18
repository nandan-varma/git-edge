/**
 * Object-level three-way merge for isomorphic-git.
 *
 * Merges two commits by walking their trees directly — no worktree, no disk.
 * Returns the merged commit OID, or throws MergeConflictError with the list of
 * conflicting file paths.
 *
 * Edge-compatible: no node: imports, uses only isomorphic-git object APIs.
 */

import type { FsClient } from "isomorphic-git";
import git from "isomorphic-git";
import { GitMergeConflictError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for threeWayMerge. */
export interface MergeOpts {
	/** Merge commit message (default: "Merge <source> into <target>"). */
	message?: string;
	/** Author name (default: "Git Edge"). */
	authorName?: string;
	/** Author email (default: "git-edge@local"). */
	authorEmail?: string;
}

/** Result of a successful merge. */
export interface MergeResult {
	commitOid: string;
}

/** Analysis of whether a merge is possible. */
export interface MergeAnalysis {
	/** True if both refs resolved. */
	canMerge: boolean;
	/** True if source is an ancestor of target (fast-forward possible). */
	fastForward: boolean;
	/** True if source and target diverged. */
	diverged: boolean;
}

/** The repo fs+gitdir shape used by isomorphic-git. */
export interface Repo {
	fs: FsClient;
	gitdir: string;
	cache?: object;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultAuthor() {
	return {
		name: "Git Edge",
		email: "git-edge@local",
		timestamp: Math.floor(Date.now() / 1000),
		timezoneOffset: 0,
	};
}

/** Read a tree object into a flat map of path → oid. */
async function _flattenTree(
	repo: Repo,
	treeOid: string,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const entries = (await git.readTree({ ...repo, oid: treeOid })).tree;
	for (const entry of entries) {
		map.set(entry.path, entry.oid);
	}
	return map;
}

/** Recursively flatten a tree into path → oid entries. */
async function flattenTreeDeep(
	repo: Repo,
	treeOid: string,
	prefix: string,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const entries = (await git.readTree({ ...repo, oid: treeOid })).tree;
	await Promise.all(
		entries.map(async (entry) => {
			const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
			if (entry.type === "tree") {
				const sub = await flattenTreeDeep(repo, entry.oid, fullPath);
				for (const [k, v] of sub) map.set(k, v);
			} else {
				map.set(fullPath, entry.oid);
			}
		}),
	);
	return map;
}

/** Read a blob and return it as a Uint8Array. */
async function readBlob(repo: Repo, oid: string): Promise<Uint8Array> {
	const { blob } = await git.readBlob({ ...repo, oid });
	return blob;
}

/** Write a blob into the object store. */
async function writeBlob(repo: Repo, content: Uint8Array): Promise<string> {
	return git.writeBlob({ ...repo, blob: content });
}

/** Write a tree object from a flat path→oid map. */
async function writeTreeObject(
	repo: Repo,
	entries: Array<{
		path: string;
		oid: string;
		mode: string;
		type: "blob" | "tree";
	}>,
): Promise<string> {
	return git.writeObject({
		...repo,
		type: "tree",
		object: entries.map((e) => ({
			path: e.path,
			oid: e.oid,
			mode: e.mode,
			type: e.type,
		})),
		format: "parsed",
	});
}

/**
 * Write a tree from a flat path→{oid,mode} map by recursively building
 * intermediate trees for subdirectories.
 */
async function writeTreeFromFlat(
	repo: Repo,
	flat: Map<string, { oid: string; mode: string }>,
): Promise<string> {
	// Group entries by first path segment
	const root = new Map<string, { oid: string; mode: string }>();
	const children = new Map<
		string,
		Map<string, { oid: string; mode: string }>
	>();

	for (const [p, v] of flat) {
		const slash = p.indexOf("/");
		if (slash === -1) {
			root.set(p, v);
		} else {
			const dir = p.slice(0, slash);
			const rest = p.slice(slash + 1);
			if (!children.has(dir)) children.set(dir, new Map());
			children.get(dir)?.set(rest, v);
		}
	}

	const treeEntries: Array<{
		path: string;
		oid: string;
		mode: string;
		type: "blob" | "tree";
	}> = [];

	for (const [name, { oid, mode }] of root) {
		treeEntries.push({ path: name, oid, mode, type: "blob" });
	}

	for (const [dirName, subMap] of children) {
		const subOid = await writeTreeFromFlat(repo, subMap);
		treeEntries.push({
			path: dirName,
			oid: subOid,
			mode: "040000",
			type: "tree",
		});
	}

	return writeTreeObject(repo, treeEntries);
}

/**
 * Simple byte-level 3-way merge on two Uint8Array contents.
 *
 * This is a line-level merge using a basic diff algorithm.
 * For production quality, callers should use the `diff` library —
 * this is the fallback for edge environments where `diff` is not available.
 */
function mergeContents(
	base: Uint8Array,
	ours: Uint8Array,
	theirs: Uint8Array,
): Uint8Array {
	const baseLines = decodeLines(base);
	const oursLines = decodeLines(ours);
	const theirsLines = decodeLines(theirs);

	// If either side is identical to base, take the other
	if (arraysEqual(baseLines, oursLines)) return theirs;
	if (arraysEqual(baseLines, theirsLines)) return ours;
	if (arraysEqual(oursLines, theirsLines)) return ours;

	// Simple line-by-line merge: walk all three in lockstep
	const result: string[] = [];
	let bi = 0,
		oi = 0,
		ti = 0;

	while (
		bi < baseLines.length ||
		oi < oursLines.length ||
		ti < theirsLines.length
	) {
		const b = bi < baseLines.length ? baseLines[bi] : undefined;
		const o = oi < oursLines.length ? oursLines[oi] : undefined;
		const t = ti < theirsLines.length ? theirsLines[ti] : undefined;

		if (b === o && b === t) {
			// All three agree
			result.push(b!);
			bi++;
			oi++;
			ti++;
		} else if (b === o) {
			// Only theirs changed
			result.push(t!);
			bi++;
			oi++;
			ti++;
		} else if (b === t) {
			// Only ours changed
			result.push(o!);
			bi++;
			oi++;
			ti++;
		} else {
			// Both changed — conflict: take ours + theirs separated by conflict markers
			result.push(`<<<<<<< ours`);
			result.push(o!);
			result.push(`=======`);
			result.push(t!);
			result.push(`>>>>>>> theirs`);
			bi++;
			oi++;
			ti++;
		}
	}

	return encodeLines(result);
}

function decodeLines(data: Uint8Array): string[] {
	const text = new TextDecoder().decode(data);
	if (text === "") return [];
	return text.split("\n");
}

function encodeLines(lines: string[]): Uint8Array {
	return new TextEncoder().encode(lines.join("\n"));
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze whether a merge is possible between two refs.
 *
 * Returns `canMerge`, `fastForward`, and `diverged` — does not attempt
 * a real content merge (no conflict detection in analysis).
 */
export async function analyzeMerge(
	repo: Repo,
	sourceRef: string,
	targetRef: string,
): Promise<MergeAnalysis> {
	try {
		const sourceOid = await git.resolveRef({ ...repo, ref: sourceRef });
		const targetOid = await git.resolveRef({ ...repo, ref: targetRef });

		const isDescendant = await git.isDescendent({
			...repo,
			oid: sourceOid,
			ancestor: targetOid,
		});

		return {
			canMerge: true,
			fastForward: isDescendant,
			diverged: !isDescendant,
		};
	} catch {
		return { canMerge: false, fastForward: false, diverged: false };
	}
}

/**
 * Perform an object-level three-way merge.
 *
 * - If source is an ancestor of target (fast-forward), moves target ref to source.
 * - If target is an ancestor of source (reverse FF), moves target ref to source.
 * - Otherwise, performs a true 3-way merge at the tree level.
 *
 * Throws `GitMergeConflictError` if the merge has unresolvable conflicts.
 */
export async function threeWayMerge(
	repo: Repo,
	sourceRef: string,
	targetRef: string,
	opts?: MergeOpts,
): Promise<MergeResult> {
	const [sourceOid, targetOid] = await Promise.all([
		git.resolveRef({ ...repo, ref: sourceRef }),
		git.resolveRef({ ...repo, ref: targetRef }),
	]);

	if (sourceOid === targetOid) {
		return { commitOid: sourceOid };
	}

	// Fast-forward: source is ahead of target
	const isSourceAhead = await git.isDescendent({
		...repo,
		oid: sourceOid,
		ancestor: targetOid,
	});
	if (isSourceAhead) {
		await git.writeRef({
			...repo,
			ref: targetRef,
			value: sourceOid,
			force: true,
		});
		return { commitOid: sourceOid };
	}

	// Reverse fast-forward: target is ahead of source
	const isTargetAhead = await git.isDescendent({
		...repo,
		oid: targetOid,
		ancestor: sourceOid,
	});
	if (isTargetAhead) {
		await git.writeRef({
			...repo,
			ref: targetRef,
			value: sourceOid,
			force: true,
		});
		return { commitOid: sourceOid };
	}

	// True 3-way merge
	const baseOids = await git.findMergeBase({
		...repo,
		oids: [sourceOid, targetOid],
	});

	if (!baseOids || baseOids.length === 0) {
		throw new Error("No merge base found between source and target");
	}

	const baseOid = baseOids[0];

	// Read commit objects to get their trees
	const [baseCommit, sourceCommit, targetCommit] = await Promise.all([
		git.readCommit({ ...repo, oid: baseOid }),
		git.readCommit({ ...repo, oid: sourceOid }),
		git.readCommit({ ...repo, oid: targetOid }),
	]);

	const baseTreeOid = baseCommit.commit.tree;
	const sourceTreeOid = sourceCommit.commit.tree;
	const targetTreeOid = targetCommit.commit.tree;

	// Flatten all three trees
	const [baseMap, sourceMap, targetMap] = await Promise.all([
		flattenTreeDeep(repo, baseTreeOid, ""),
		flattenTreeDeep(repo, sourceTreeOid, ""),
		flattenTreeDeep(repo, targetTreeOid, ""),
	]);

	// Collect all unique paths
	const allPaths = new Set([
		...baseMap.keys(),
		...sourceMap.keys(),
		...targetMap.keys(),
	]);

	const resultEntries = new Map<string, { oid: string; mode: string }>();
	const conflictingPaths: string[] = [];

	for (const filepath of allPaths) {
		const baseOid = baseMap.get(filepath);
		const sourceOid = sourceMap.get(filepath);
		const targetOid = targetMap.get(filepath);

		const _baseExists = baseOid !== undefined;
		const sourceExists = sourceOid !== undefined;
		const targetExists = targetOid !== undefined;

		if (sourceExists && !targetExists) {
			// Added in source, not in target — take source
			resultEntries.set(filepath, { oid: sourceOid!, mode: "100644" });
		} else if (!sourceExists && targetExists) {
			// Deleted in source, exists in target — keep target
			resultEntries.set(filepath, { oid: targetOid!, mode: "100644" });
		} else if (sourceExists && targetExists) {
			// Exists in both — check if both changed from base
			const sourceChanged = sourceOid !== baseOid;
			const targetChanged = targetOid !== baseOid;

			if (!sourceChanged && !targetChanged) {
				// Neither changed — keep as-is
				resultEntries.set(filepath, { oid: targetOid!, mode: "100644" });
			} else if (!sourceChanged) {
				// Only target changed — take target
				resultEntries.set(filepath, { oid: targetOid!, mode: "100644" });
			} else if (!targetChanged) {
				// Only source changed — take source
				resultEntries.set(filepath, { oid: sourceOid!, mode: "100644" });
			} else {
				// Both changed — attempt content merge
				const [baseContent, sourceContent, targetContent] = await Promise.all([
					readBlob(repo, baseOid!),
					readBlob(repo, sourceOid!),
					readBlob(repo, targetOid!),
				]);

				if (
					baseContent.length === sourceContent.length &&
					baseContent.every((b, i) => b === sourceContent[i])
				) {
					// Source is identical to base — take target
					resultEntries.set(filepath, { oid: targetOid!, mode: "100644" });
				} else if (
					baseContent.length === targetContent.length &&
					baseContent.every((b, i) => b === targetContent[i])
				) {
					// Target is identical to base — take source
					resultEntries.set(filepath, { oid: sourceOid!, mode: "100644" });
				} else if (
					sourceContent.length === targetContent.length &&
					sourceContent.every((b, i) => b === targetContent[i])
				) {
					// Source and target are identical — keep either
					resultEntries.set(filepath, { oid: sourceOid!, mode: "100644" });
				} else {
					// Both truly changed — attempt line-level merge
					const merged = mergeContents(
						baseContent,
						sourceContent,
						targetContent,
					);

					// Check for conflict markers
					const mergedText = new TextDecoder().decode(merged);
					if (
						mergedText.includes("<<<<<<< ours") ||
						mergedText.includes(">>>>>>> theirs")
					) {
						conflictingPaths.push(filepath);
						// Still take the merged result with conflict markers
						// so the caller can see what happened
						const mergedOid = await writeBlob(repo, merged);
						resultEntries.set(filepath, { oid: mergedOid, mode: "100644" });
					} else {
						const mergedOid = await writeBlob(repo, merged);
						resultEntries.set(filepath, { oid: mergedOid, mode: "100644" });
					}
				}
			}
		} else {
			// Deleted in both — no-op
		}
	}

	if (conflictingPaths.length > 0) {
		throw new GitMergeConflictError(conflictingPaths);
	}

	// Build the result tree
	const resultTreeOid = await writeTreeFromFlat(repo, resultEntries);

	// Create the merge commit
	const author = opts?.authorName
		? {
				name: opts.authorName,
				email: opts.authorEmail || "git-edge@local",
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			}
		: defaultAuthor();

	const message = opts?.message || `Merge ${sourceRef} into ${targetRef}`;

	const mergeCommitOid = await git.commit({
		...repo,
		message,
		tree: resultTreeOid,
		parent: [targetOid, sourceOid],
		author,
		committer: author,
	});

	// Update the target ref
	await git.writeRef({
		...repo,
		ref: targetRef,
		value: mergeCommitOid,
		force: true,
	});

	return { commitOid: mergeCommitOid };
}
