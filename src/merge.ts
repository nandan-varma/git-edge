/**
 * Object-level three-way merge for isomorphic-git.
 *
 * Merges two commits by walking their trees directly — no worktree, no disk.
 * Returns the merged commit OID, or throws MergeConflictError with the list of
 * conflicting file paths.
 *
 * Edge-compatible: no node: imports, uses only isomorphic-git object APIs.
 */

import type { Repo } from "git-fs-s3/ops";
import git from "isomorphic-git";
import { merge as diff3Merge } from "node-diff3";
import { GitMergeConflictError } from "./errors.js";

export type { Repo };

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
 * Line-level 3-way merge, via node-diff3's LCS-based diff3 algorithm — the
 * same approach GNU diffutils' `diff3` (and git's own default merge driver)
 * use. Conflicts are marked with git's standard `<<<<<<< ours` / `=======` /
 * `>>>>>>> theirs` markers; `conflict` reports whether any were needed.
 *
 * Previously a hand-rolled lockstep line-by-line walk (compare base[i] vs
 * ours[i] vs theirs[i] at the same index across all three): correct only
 * when no side ever inserts or deletes a line, since any such edit shifts
 * every later index out of alignment — which the walk had no way to detect
 * or recover from, so it could misreport unrelated later lines as
 * conflicting, or — with no conflict raised — silently merge misaligned
 * lines into corrupted content.
 */
function mergeContents(
	base: Uint8Array,
	ours: Uint8Array,
	theirs: Uint8Array,
): { content: Uint8Array; conflict: boolean } {
	const { conflict, result } = diff3Merge(
		decodeLines(ours),
		decodeLines(base),
		decodeLines(theirs),
		{ label: { a: "ours", b: "theirs" } },
	);
	return { content: encodeLines(result), conflict };
}

function decodeLines(data: Uint8Array): string[] {
	const text = new TextDecoder().decode(data);
	if (text === "") return [];
	return text.split("\n");
}

function encodeLines(lines: string[]): Uint8Array {
	return new TextEncoder().encode(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

		if (sourceOid !== undefined && targetOid === undefined) {
			// Added in source, not in target — take source
			resultEntries.set(filepath, { oid: sourceOid, mode: "100644" });
		} else if (sourceOid === undefined && targetOid !== undefined) {
			// Deleted in source, exists in target — keep target
			resultEntries.set(filepath, { oid: targetOid, mode: "100644" });
		} else if (sourceOid !== undefined && targetOid !== undefined) {
			// Exists in both — check if both changed from base. A path with
			// no base entry (both sides independently added it — no common
			// ancestor content to diff against) is its own case below,
			// compared directly against each other instead of a base blob
			// that doesn't exist.
			const sourceChanged = sourceOid !== baseOid;
			const targetChanged = targetOid !== baseOid;

			if (!sourceChanged && !targetChanged) {
				// Neither changed — keep as-is
				resultEntries.set(filepath, { oid: targetOid, mode: "100644" });
			} else if (!sourceChanged) {
				// Only target changed — take target
				resultEntries.set(filepath, { oid: targetOid, mode: "100644" });
			} else if (!targetChanged) {
				// Only source changed — take source
				resultEntries.set(filepath, { oid: sourceOid, mode: "100644" });
			} else if (baseOid === undefined) {
				// Both sides independently added this path. Same oid means
				// identical content on both sides — no real conflict. Different
				// oids is a genuine conflict with no common ancestor to 3-way
				// merge against, so run the line-level merge against an empty
				// "base" — mergeContents already treats an exhausted side as
				// producing full conflict markers around whatever content the
				// other side has.
				if (sourceOid === targetOid) {
					resultEntries.set(filepath, { oid: sourceOid, mode: "100644" });
				} else {
					const [sourceContent, targetContent] = await Promise.all([
						readBlob(repo, sourceOid),
						readBlob(repo, targetOid),
					]);
					const { content, conflict } = mergeContents(
						new Uint8Array(),
						sourceContent,
						targetContent,
					);
					if (conflict) conflictingPaths.push(filepath);
					const mergedOid = await writeBlob(repo, content);
					resultEntries.set(filepath, { oid: mergedOid, mode: "100644" });
				}
			} else if (sourceOid === targetOid) {
				// Both changed from base, but to identical content (a real,
				// reachable case — e.g. both sides applied the same
				// formatter) — oid equality already proves this, no blob
				// read needed. (The reverse isn't checked: sourceOid or
				// targetOid equaling baseOid was already ruled out by
				// sourceChanged/targetChanged above, so source/target can
				// never equal base content here — no byte comparison against
				// base is reachable either.)
				resultEntries.set(filepath, { oid: sourceOid, mode: "100644" });
			} else {
				// Both changed from base, to different content — attempt a
				// real line-level merge.
				const [baseContent, sourceContent, targetContent] = await Promise.all([
					readBlob(repo, baseOid),
					readBlob(repo, sourceOid),
					readBlob(repo, targetOid),
				]);
				const { content, conflict } = mergeContents(
					baseContent,
					sourceContent,
					targetContent,
				);
				if (conflict) conflictingPaths.push(filepath);
				const mergedOid = await writeBlob(repo, content);
				resultEntries.set(filepath, { oid: mergedOid, mode: "100644" });
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
