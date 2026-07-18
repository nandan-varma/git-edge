import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeMerge, threeWayMerge } from "../src/merge.js";

let tmpDir: string;

const AUTHOR = "Test <test@test.com> 1000000000 +0000";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-edge-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createBareRepo(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
	const cache = {};
	await git.init({ fs, dir, defaultBranch: "main", bare: true });

	const readmeOid = await git.writeBlob({
		fs,
		gitdir: dir,
		blob: new TextEncoder().encode("# Test Repo"),
	});
	const treeOid = await git.writeTree({
		fs,
		gitdir: dir,
		tree: [{ path: "README.md", type: "blob", oid: readmeOid, mode: "100644" }],
	});
	const commitOid = await git.writeObject({
		fs,
		gitdir: dir,
		type: "commit",
		object: new TextEncoder().encode(
			`tree ${treeOid}\nauthor ${AUTHOR}\ncommitter ${AUTHOR}\n\nInitial commit`,
		),
		format: "content",
	});
	await git.writeRef({
		fs,
		gitdir: dir,
		ref: "refs/heads/main",
		value: commitOid,
		force: true,
	});

	return { fs, gitdir: dir, cache };
}

async function makeCommit(
	repo: { fs: typeof fs; gitdir: string; cache: object },
	parentOid: string,
	files: Array<{ path: string; content: string }>,
	message: string,
): Promise<string> {
	// Start from parent's tree
	const parentCommit = await git.readCommit({ ...repo, oid: parentOid });
	const parentTree = await git.readTree({
		...repo,
		oid: parentCommit.commit.tree,
	});
	const fileMap = new Map<string, { oid: string; mode: string }>();
	for (const entry of parentTree.tree) {
		if (entry.type === "blob") {
			fileMap.set(entry.path, { oid: entry.oid, mode: entry.mode });
		}
	}

	// Overlay new files
	for (const f of files) {
		const oid = await git.writeBlob({
			...repo,
			blob: new TextEncoder().encode(f.content),
		});
		fileMap.set(f.path, { oid, mode: "100644" });
	}

	const treeEntries = Array.from(fileMap.entries()).map(
		([name, { oid, mode }]) => ({
			path: name,
			type: "blob" as const,
			oid,
			mode,
		}),
	);
	const treeOid = await git.writeTree({ ...repo, tree: treeEntries });

	const { cache: _, ...repoNoCache } = repo;
	const commitOid = await git.writeObject({
		...repoNoCache,
		type: "commit",
		object: new TextEncoder().encode(
			`tree ${treeOid}\nparent ${parentOid}\nauthor ${AUTHOR}\ncommitter ${AUTHOR}\n\n${message}`,
		),
		format: "content",
	});

	return commitOid;
}

describe("analyzeMerge", () => {
	it("detects fast-forward", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo1"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const featureOid = await makeCommit(
			repo,
			mainOid,
			[{ path: "feature.txt", content: "new feature" }],
			"Add feature",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: featureOid,
			force: true,
		});

		const analysis = await analyzeMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		expect(analysis.canMerge).toBe(true);
		expect(analysis.fastForward).toBe(true);
		expect(analysis.diverged).toBe(false);
	});

	it("detects diverged branches", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo2"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const featureOid = await makeCommit(
			repo,
			mainOid,
			[{ path: "feature.txt", content: "feature content" }],
			"Add feature",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: featureOid,
			force: true,
		});

		const mainOid2 = await makeCommit(
			repo,
			mainOid,
			[{ path: "main.txt", content: "main content" }],
			"Add main.txt",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/main",
			value: mainOid2,
			force: true,
		});

		const analysis = await analyzeMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		expect(analysis.canMerge).toBe(true);
		expect(analysis.fastForward).toBe(false);
		expect(analysis.diverged).toBe(true);
	});

	it("returns canMerge: false for missing ref", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo3"));
		const analysis = await analyzeMerge(
			repo,
			"refs/heads/nonexistent",
			"refs/heads/main",
		);
		expect(analysis.canMerge).toBe(false);
	});

	it("propagates a non-NotFoundError instead of reporting canMerge: false", async () => {
		// Both refs resolve fine — the failure is in the ancestry walk
		// (isDescendent), which can fail for reasons unrelated to either ref
		// existing (a corrupted object, a storage read error) and shouldn't be
		// reported to the caller as "one of these branches doesn't exist".
		const repo = await createBareRepo(path.join(tmpDir, "repo3b"));
		const isDescendentSpy = vi
			.spyOn(git, "isDescendent")
			.mockRejectedValue(new Error("object read failed"));

		try {
			await expect(
				analyzeMerge(repo, "refs/heads/main", "refs/heads/main"),
			).rejects.toThrow("object read failed");
		} finally {
			isDescendentSpy.mockRestore();
		}
	});
});

describe("threeWayMerge", () => {
	it("fast-forwards when source is ahead", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo4"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const featureOid = await makeCommit(
			repo,
			mainOid,
			[{ path: "feature.txt", content: "feature content" }],
			"Add feature",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: featureOid,
			force: true,
		});

		const result = await threeWayMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		expect(result.commitOid).toBe(featureOid);

		const newMainOid = await git.resolveRef({
			...repo,
			ref: "refs/heads/main",
		});
		expect(newMainOid).toBe(featureOid);
	});

	it("merges non-conflicting changes", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo5"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const featureOid = await makeCommit(
			repo,
			mainOid,
			[{ path: "feature.txt", content: "feature content" }],
			"Add feature",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: featureOid,
			force: true,
		});

		const mainOid2 = await makeCommit(
			repo,
			mainOid,
			[{ path: "main.txt", content: "main content" }],
			"Add main.txt",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/main",
			value: mainOid2,
			force: true,
		});

		const result = await threeWayMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		expect(result.commitOid).toBeDefined();
		expect(result.commitOid).not.toBe(mainOid2);

		const commit = await git.readCommit({ ...repo, oid: result.commitOid });
		const mergedTree = await git.readTree({ ...repo, oid: commit.commit.tree });
		const treePaths = mergedTree.tree.map((e) => e.path).sort();
		expect(treePaths).toContain("feature.txt");
		expect(treePaths).toContain("main.txt");
		expect(treePaths).toContain("README.md");
	});

	it("returns same oid when source === target", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo6"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: mainOid,
			force: true,
		});

		const result = await threeWayMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		expect(result.commitOid).toBe(mainOid);
	});

	it("handles file modifications on one side only", async () => {
		const repo = await createBareRepo(path.join(tmpDir, "repo7"));
		const mainOid = await git.resolveRef({ ...repo, ref: "refs/heads/main" });

		const featureOid = await makeCommit(
			repo,
			mainOid,
			[{ path: "README.md", content: "# Updated README" }],
			"Update README",
		);
		await git.writeRef({
			...repo,
			ref: "refs/heads/feature",
			value: featureOid,
			force: true,
		});

		const result = await threeWayMerge(
			repo,
			"refs/heads/feature",
			"refs/heads/main",
		);
		const commit = await git.readCommit({ ...repo, oid: result.commitOid });
		const mergedTree = await git.readTree({ ...repo, oid: commit.commit.tree });
		const readmeEntry = mergedTree.tree.find((e) => e.path === "README.md");
		if (!readmeEntry) throw new Error("README.md missing from merged tree");

		const { blob } = await git.readBlob({ ...repo, oid: readmeEntry.oid });
		expect(new TextDecoder().decode(blob)).toBe("# Updated README");
	});
});
