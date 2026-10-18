/**
 * Shared fixture harness for threeWayMerge tests: a bare repo on git-fs-s3's
 * in-memory object store, plus a path → content "spec" builder for writing
 * trees and commits.
 */
import { createGitFs, MemoryObjectStore, type ObjectStore } from "git-fs-s3";
import type { Repo } from "git-fs-s3/ops";
import git from "isomorphic-git";
import { threeWayMerge } from "../src/merge.js";

export const author = {
	name: "T",
	email: "t@t",
	timestamp: 1_000_000_000,
	timezoneOffset: 0,
};

export type Spec = Record<
	string,
	| string
	| { content: string | Uint8Array; mode: string }
	| { oid: string; mode: "160000" }
>;

export async function makeRepo(
	store: ObjectStore = new MemoryObjectStore(),
): Promise<{ repo: Repo; store: ObjectStore }> {
	const repo = { fs: createGitFs(store), gitdir: "git", cache: {} };
	await git.init({
		...repo,
		dir: repo.gitdir,
		bare: true,
		defaultBranch: "main",
	});
	return { repo, store };
}

/** Write a tree for a full path → content spec (nested paths allowed). */
export async function writeSpec(repo: Repo, spec: Spec): Promise<string> {
	const files = new Map<string, Spec[string]>();
	const dirs = new Map<string, Spec>();
	for (const [path, value] of Object.entries(spec)) {
		const slash = path.indexOf("/");
		if (slash === -1) files.set(path, value);
		else {
			const dir = path.slice(0, slash);
			const sub = dirs.get(dir) ?? {};
			sub[path.slice(slash + 1)] = value;
			dirs.set(dir, sub);
		}
	}
	const tree = [];
	for (const [name, value] of files) {
		if (typeof value !== "string" && "oid" in value) {
			tree.push({
				path: name,
				mode: value.mode,
				type: "commit" as const,
				oid: value.oid,
			});
			continue;
		}
		const { content, mode } =
			typeof value === "string" ? { content: value, mode: "100644" } : value;
		const blob =
			typeof content === "string" ? new TextEncoder().encode(content) : content;
		tree.push({
			path: name,
			mode,
			type: "blob" as const,
			oid: await git.writeBlob({ ...repo, blob }),
		});
	}
	for (const [name, sub] of dirs) {
		tree.push({
			path: name,
			mode: "040000",
			type: "tree" as const,
			oid: await writeSpec(repo, sub),
		});
	}
	return git.writeTree({ ...repo, tree });
}

export async function commit(
	repo: Repo,
	branch: string,
	spec: Spec,
	parents: string[],
): Promise<string> {
	const oid = await git.writeCommit({
		...repo,
		commit: {
			message: `${branch}\n`,
			tree: await writeSpec(repo, spec),
			parent: parents,
			author,
			committer: author,
		},
	});
	await git.writeRef({
		...repo,
		ref: `refs/heads/${branch}`,
		value: oid,
		force: true,
	});
	return oid;
}

/** base on main, then `ours` on main and `theirs` on feature. */
export async function diverge(
	base: Spec,
	ours: Spec,
	theirs: Spec,
	store: ObjectStore = new MemoryObjectStore(),
) {
	const made = await makeRepo(store);
	const { repo } = made;
	const baseOid = await commit(repo, "main", base, []);
	await commit(repo, "feature", theirs, [baseOid]);
	await commit(repo, "main", ours, [baseOid]);
	return made;
}

/** Every blob in a commit's tree, keyed by full path. */
export async function mergedFiles(repo: Repo, oid: string) {
	const out: Record<string, { mode: string; text: string }> = {};
	await git.walk({
		...repo,
		trees: [git.TREE({ ref: oid })],
		map: async (path, [entry]) => {
			if (!entry || (await entry.type()) !== "blob") return;
			out[path] = {
				mode: (await entry.mode()).toString(8),
				text: new TextDecoder().decode(
					(await entry.content()) ?? new Uint8Array(),
				),
			};
		},
	});
	return out;
}

/** Every entry (blob, tree, commit/submodule) in a commit's full tree. */
export async function treeEntries(
	repo: Repo,
	oid: string,
): Promise<Map<string, { mode: string; oid: string; type: string }>> {
	const out = new Map<string, { mode: string; oid: string; type: string }>();
	await git.walk({
		...repo,
		trees: [git.TREE({ ref: oid })],
		map: async (path, [entry]) => {
			if (!entry) return;
			out.set(path, {
				mode: (await entry.mode()).toString(8),
				oid: await entry.oid(),
				type: await entry.type(),
			});
		},
	});
	return out;
}

/** Merge `feature` into `main`, the layout `diverge` sets up. */
export const merge = (repo: Repo) =>
	threeWayMerge(repo, "refs/heads/feature", "refs/heads/main", {
		authorName: "M",
		authorEmail: "m@m",
	});
