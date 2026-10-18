/**
 * threeWayMerge semantics: one-sided changes (deletions included), modes,
 * binary files, structural conflicts, no-op merges, and which refs move.
 * Runs against git-fs-s3's in-memory object store.
 */
import { createGitFs, MemoryObjectStore } from "git-fs-s3";
import type { Repo } from "git-fs-s3/ops";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { GitEdgeError, GitMergeConflictError } from "../src/errors.js";
import { threeWayMerge } from "../src/merge.js";

const author = {
	name: "T",
	email: "t@t",
	timestamp: 1_000_000_000,
	timezoneOffset: 0,
};

type Spec = Record<
	string,
	| string
	| { content: string | Uint8Array; mode: string }
	| { oid: string; mode: "160000" }
>;

async function makeRepo(): Promise<{ repo: Repo; store: MemoryObjectStore }> {
	const store = new MemoryObjectStore();
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
async function writeSpec(repo: Repo, spec: Spec): Promise<string> {
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

async function commit(
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
async function diverge(base: Spec, ours: Spec, theirs: Spec) {
	const { repo, store } = await makeRepo();
	const baseOid = await commit(repo, "main", base, []);
	await commit(repo, "feature", theirs, [baseOid]);
	await commit(repo, "main", ours, [baseOid]);
	return { repo, store };
}

async function mergedFiles(repo: Repo, oid: string) {
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

const merge = (repo: Repo) =>
	threeWayMerge(repo, "refs/heads/feature", "refs/heads/main", {
		authorName: "M",
		authorEmail: "m@m",
	});

describe("threeWayMerge semantics", () => {
	it("keeps a deletion made on one side", async () => {
		const { repo } = await diverge(
			{ "a.txt": "a\n", "b.txt": "b\n" },
			{ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" },
			{ "a.txt": "a\n" }, // feature deleted b.txt
		);
		const { commitOid } = await merge(repo);
		expect(Object.keys(await mergedFiles(repo, commitOid)).sort()).toEqual([
			"a.txt",
			"c.txt",
		]);
	});

	it("reports modify/delete as a conflict", async () => {
		const { repo } = await diverge(
			{ "a.txt": "a\n" },
			{ "a.txt": "changed\n" },
			{},
		);
		await expect(merge(repo)).rejects.toMatchObject({
			conflictingPaths: ["a.txt"],
		});
	});

	it("keeps file modes (executable bit) on both one-sided and merged changes", async () => {
		const run = { content: "#!/bin/sh\none\ntwo\nthree\n", mode: "100755" };
		const { repo } = await diverge(
			{ "run.sh": run, "x.txt": "x\n" },
			{
				"run.sh": { content: "#!/bin/sh\nONE\ntwo\nthree\n", mode: "100755" },
				"x.txt": "x\n",
			},
			{
				"run.sh": { content: "#!/bin/sh\none\ntwo\nTHREE\n", mode: "100755" },
				"x.txt": "y\n",
			},
		);
		const { commitOid } = await merge(repo);
		const files = await mergedFiles(repo, commitOid);
		expect(files["run.sh"]).toEqual({
			mode: "100755",
			text: "#!/bin/sh\nONE\ntwo\nTHREE\n",
		});
		expect(files["x.txt"]?.text).toBe("y\n");
	});

	it("takes a mode change made on one side", async () => {
		const { repo } = await diverge(
			{ "run.sh": "echo\n", other: "o\n" },
			{ "run.sh": "echo\n", other: "changed\n" },
			{ "run.sh": { content: "echo\n", mode: "100755" }, other: "o\n" },
		);
		const { commitOid } = await merge(repo);
		expect((await mergedFiles(repo, commitOid))["run.sh"]?.mode).toBe("100755");
	});

	it("never line-merges binary files", async () => {
		const bin = (byte: number) => ({
			content: new Uint8Array([0, 1, 2, byte, 10, 5, 6]),
			mode: "100644",
		});
		const { repo } = await diverge(
			{ "img.bin": bin(1) },
			{ "img.bin": bin(2) },
			{ "img.bin": bin(3) },
		);
		await expect(merge(repo)).rejects.toBeInstanceOf(GitMergeConflictError);
	});

	it("reports a file/directory clash as a conflict instead of writing a corrupt tree", async () => {
		const { repo } = await diverge(
			{ "keep.txt": "k\n" },
			{ "keep.txt": "k\n", thing: "a file\n" },
			{ "keep.txt": "k\n", "thing/inner.txt": "a dir\n" },
		);
		await expect(merge(repo)).rejects.toMatchObject({
			conflictingPaths: ["thing"],
		});
	});

	it("merges nested changes without touching unrelated subtrees", async () => {
		const { repo } = await diverge(
			{ "a/x.txt": "1\n", "b/y.txt": "1\n", "c/z.txt": "1\n" },
			{ "a/x.txt": "ours\n", "b/y.txt": "1\n", "c/z.txt": "1\n" },
			{ "a/x.txt": "1\n", "b/y.txt": "theirs\n", "c/z.txt": "1\n" },
		);
		const { commitOid } = await merge(repo);
		const files = await mergedFiles(repo, commitOid);
		expect(files["a/x.txt"]?.text).toBe("ours\n");
		expect(files["b/y.txt"]?.text).toBe("theirs\n");
		expect(files["c/z.txt"]?.text).toBe("1\n");
	});

	it("is a no-op when the target already contains the source — never moves target back", async () => {
		const { repo } = await makeRepo();
		const base = await commit(repo, "feature", { "a.txt": "a\n" }, []);
		const ahead = await commit(
			repo,
			"main",
			{ "a.txt": "a\n", "b.txt": "b\n" },
			[base],
		);
		const { commitOid } = await merge(repo);
		expect(commitOid).toBe(ahead);
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(
			ahead,
		);
	});

	it("moves only the target ref, never the branch HEAD names", async () => {
		const { repo } = await diverge(
			{ "a.txt": "a\n" },
			{ "a.txt": "a\n", "o.txt": "o\n" },
			{ "a.txt": "a\n", "t.txt": "t\n" },
		);
		// Merge main into feature: HEAD (main) must stay put.
		const mainBefore = await git.resolveRef({
			...repo,
			ref: "refs/heads/main",
		});
		const { commitOid } = await threeWayMerge(
			repo,
			"refs/heads/main",
			"refs/heads/feature",
		);
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/main" })).toBe(
			mainBefore,
		);
		expect(await git.resolveRef({ ...repo, ref: "refs/heads/feature" })).toBe(
			commitOid,
		);
	});

	it("stores the merge's objects as a pack, not loose objects", async () => {
		const { repo, store } = await diverge(
			{ "a.txt": "1\n2\n3\n" },
			{ "a.txt": "one\n2\n3\n" },
			{ "a.txt": "1\n2\nthree\n" },
		);
		const before = new Set(
			(await store.list("git/objects/")).objects.map((o) => o.key),
		);
		await merge(repo);
		const added = (await store.list("git/objects/")).objects
			.map((o) => o.key)
			.filter((key) => !before.has(key));
		expect(added.some((key) => /objects\/[0-9a-f]{2}\//.test(key))).toBe(false);
		expect(added.some((key) => key.endsWith(".pack"))).toBe(true);
	});

	it("refuses unrelated histories with a typed error", async () => {
		const { repo } = await makeRepo();
		await commit(repo, "main", { "a.txt": "a\n" }, []);
		await commit(repo, "feature", { "b.txt": "b\n" }, []);
		await expect(merge(repo)).rejects.toBeInstanceOf(GitEdgeError);
	});
});

describe("submodule merges", () => {
	const a = { oid: "1".repeat(40), mode: "160000" as const };
	const b = { oid: "2".repeat(40), mode: "160000" as const };
	const c = { oid: "3".repeat(40), mode: "160000" as const };
	it.each<{
		base: Spec;
		ours: Spec;
		theirs: Spec;
		expected: { oid: string; mode: "160000" } | null;
	}>([
		{
			base: { lib: a },
			ours: { lib: a, ours: "ours" },
			theirs: { lib: b },
			expected: b,
		},
		{
			base: { lib: a },
			ours: { lib: b, ours: "ours" },
			theirs: { lib: a },
			expected: b,
		},
		{
			base: { lib: a },
			ours: { lib: b, ours: "ours" },
			theirs: { lib: b },
			expected: b,
		},
		{
			base: { lib: a },
			ours: { lib: a, ours: "ours" },
			theirs: {},
			expected: null,
		},
		{ base: {}, ours: { ours: "ours" }, theirs: { lib: a }, expected: a },
	])(
		"preserves a clean pointer decision %#",
		async ({ base, ours, theirs, expected }) => {
			const { repo } = await diverge(base, ours, theirs);
			const { commitOid } = await threeWayMerge(repo, "feature", "main");
			const { commit: c } = await git.readCommit({ ...repo, oid: commitOid });
			const { tree } = await git.readTree({ ...repo, oid: c.tree });
			const entry = tree.find((e) => e.path === "lib");
			if (expected)
				expect(entry).toMatchObject({ ...expected, type: "commit" });
			else expect(entry).toBeUndefined();
		},
	);
	it.each<{ ours: Spec; theirs: Spec }>([
		{ ours: { lib: b }, theirs: { lib: c } },
		{ ours: {}, theirs: { lib: b } },
		{ ours: { lib: b }, theirs: { lib: "ordinary file" } },
		{ ours: { lib: b }, theirs: { "lib/file": "directory" } },
	])(
		"reports conflicting pointer/structure changes without moving refs %#",
		async ({ ours, theirs }) => {
			const { repo } = await diverge({ lib: a }, ours, theirs);
			const before = await git.resolveRef({ ...repo, ref: "main" });
			await expect(
				threeWayMerge(repo, "feature", "main"),
			).rejects.toMatchObject({ conflictingPaths: ["lib"] });
			expect(await git.resolveRef({ ...repo, ref: "main" })).toBe(before);
		},
	);
});
