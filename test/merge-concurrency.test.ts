/**
 * threeWayMerge bounds its in-flight object I/O with one shared semaphore per
 * merge. The permit is never held across the recursive subtree merge — doing
 * so deadlocks as soon as every permit is owned by a caller waiting for
 * another permit.
 */
import { MemoryObjectStore, type ObjectStore } from "git-fs-s3";
import type { Repo } from "git-fs-s3/ops";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_READS } from "../src/merge.js";
import {
	diverge,
	merge,
	type Spec,
	treeEntries,
	writeSpec,
} from "./merge-harness.js";

/** A store that records the peak number of simultaneous operations. */
class CountingStore implements ObjectStore {
	private readonly inner: MemoryObjectStore;
	private inFlight = 0;
	private peakInFlight = 0;

	constructor(inner: MemoryObjectStore = new MemoryObjectStore()) {
		this.inner = inner;
	}

	private async track<T>(op: () => Promise<T>): Promise<T> {
		this.inFlight += 1;
		if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
		try {
			return await op();
		} finally {
			this.inFlight -= 1;
		}
	}

	get(key: string): Promise<Uint8Array | null> {
		return this.track(() => this.inner.get(key));
	}

	put(key: string, data: Uint8Array): Promise<void> {
		return this.track(() => this.inner.put(key, data));
	}

	delete(key: string): Promise<void> {
		return this.track(() => this.inner.delete(key));
	}

	head(key: string): Promise<{ size: number } | null> {
		return this.track(() => this.inner.head(key));
	}

	list(prefix: string, options?: Parameters<ObjectStore["list"]>[1]) {
		return this.track(() => this.inner.list(prefix, options));
	}

	get peak(): number {
		return this.peakInFlight;
	}

	resetPeak(): void {
		this.peakInFlight = this.inFlight;
	}
}

const pad = (n: number) => String(n).padStart(3, "0");

/** One directory with `count` files, every file changed on both sides. */
function wideSpecs(count: number) {
	const base: Spec = {};
	const ours: Spec = {};
	const theirs: Spec = {};
	for (let i = 0; i < count; i++) {
		const path = `wide/${pad(i)}.txt`;
		base[path] = "1\n2\n3\n";
		ours[path] = "ours\n2\n3\n";
		theirs[path] = "1\n2\ntheirs\n";
	}
	return { base, ours, theirs };
}

/** `count` top-level sibling dirs, plus a chain reached only by recursion. */
function wideAndDeepSpecs(count: number) {
	const base: Spec = {};
	const ours: Spec = {};
	const theirs: Spec = {};
	// Top-level sibling directories (not one directory with many files): each
	// is merged by recursing, so a permit held across the recursive merge runs
	// out here as soon as `count` exceeds the limit.
	for (let i = 0; i < count; i++) {
		const path = `d${pad(i)}/file.txt`;
		base[path] = "1\n2\n3\n";
		ours[path] = "ours\n2\n3\n";
		theirs[path] = "1\n2\ntheirs\n";
	}
	const deep = "deep/a/b/c/d/leaf.txt";
	base[deep] = "1\n2\n3\n";
	ours[deep] = "ours\n2\n3\n";
	theirs[deep] = "1\n2\ntheirs\n";
	ours["ours-only.txt"] = "added by ours\n";
	theirs["theirs-only.txt"] = "added by theirs\n";
	return { base, ours, theirs, deep };
}

/** Sorted path → entry pair, so Map insertion order isn't compared. */
async function sortedEntries(repo: Repo, tree: string) {
	return [...(await treeEntries(repo, tree)).entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
}

describe("threeWayMerge concurrency", () => {
	it("never runs more than MAX_CONCURRENT_READS object operations at once", async () => {
		const { base, ours, theirs } = wideSpecs(200);
		const store = new CountingStore();
		const { repo } = await diverge(base, ours, theirs, store);
		// The tree a merge with no bound at all produces: diff3 resolves each
		// entry to ours' first line and theirs' last line.
		const expected: Spec = {};
		for (const path of Object.keys(base)) expected[path] = "ours\n2\ntheirs\n";
		const expectedTree = await writeSpec(repo, expected);

		store.resetPeak();
		const { commitOid } = await merge(repo);
		const { commit } = await git.readCommit({ ...repo, oid: commitOid });

		expect(commit.tree).toBe(expectedTree);
		expect(store.peak).toBeGreaterThan(1);
		expect(store.peak).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
	}, 15000);

	it("merges wide and deeply nested trees to the same entries as an unthrottled merge", async () => {
		const { base, ours, theirs, deep } = wideAndDeepSpecs(40);
		const { repo } = await diverge(base, ours, theirs);
		const { commitOid } = await merge(repo);
		const { commit } = await git.readCommit({ ...repo, oid: commitOid });

		const expected: Spec = {};
		for (let i = 0; i < 40; i++)
			expected[`d${pad(i)}/file.txt`] = "ours\n2\ntheirs\n";
		expected[deep] = "ours\n2\ntheirs\n";
		expected["ours-only.txt"] = "added by ours\n";
		expected["theirs-only.txt"] = "added by theirs\n";
		const expectedTree = await writeSpec(repo, expected);

		const actual = await treeEntries(repo, commit.tree);
		expect(
			[...actual.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		).toEqual(await sortedEntries(repo, expectedTree));
		// leaf.txt sits five levels down; only recursion can reach it.
		expect(actual.get(deep)).toMatchObject({ mode: "100644", type: "blob" });
		expect(actual.get("deep/a/b/c/d")).toMatchObject({
			mode: "40000",
			type: "tree",
		});
	}, 15000);
});
