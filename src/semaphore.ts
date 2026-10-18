/**
 * A tiny FIFO semaphore for bounding concurrent async I/O.
 *
 * Recursive callers (a tree merge recursing into subtrees) can't bound
 * in-flight I/O with a per-level limit — the level limit multiplies by depth.
 * A single shared instance caps the *total* instead.
 *
 * Edge-compatible: no node: imports, no timers, no polling.
 */

export interface Semaphore {
	/**
	 * Run `fn` once a permit is free, releasing it when `fn` settles.
	 *
	 * The permit must not be held across work that itself needs one — with
	 * every permit held by callers blocked on new permits, the pool deadlocks.
	 * Wrap the individual I/O call, not a recursive subtree merge.
	 */
	run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a semaphore that runs at most `limit` callbacks at once.
 *
 * `limit` must be a positive integer: a fractional or non-finite bound has no
 * useful meaning as a concurrency count, and would silently behave like an
 * unbounded pool (comparisons against it are never satisfied as intended).
 */
export function createSemaphore(limit: number): Semaphore {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(
			`Semaphore limit must be a positive integer, got ${limit}`,
		);
	}
	let active = 0;
	const waiting: Array<() => void> = [];

	function acquire(): Promise<void> {
		if (active < limit) {
			active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => waiting.push(resolve));
	}

	function release(): void {
		// Hand the permit straight to the next waiter rather than dropping and
		// re-acquiring it: decrementing first would let a fresh caller jump the
		// queue and starve whoever has been waiting longest.
		const next = waiting.shift();
		if (next) next();
		else active -= 1;
	}

	return {
		async run<T>(fn: () => Promise<T>): Promise<T> {
			await acquire();
			try {
				return await fn();
			} finally {
				release();
			}
		},
	};
}
