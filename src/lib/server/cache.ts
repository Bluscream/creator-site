/**
 * A small file cache that is safe to read while it is being written.
 *
 * Ported from the PHP original, which earned each of its properties the hard way:
 *
 * 1. **It writes outside anything that is served.** The first version wrote into the document root
 *    and the web user could not write there, so the cache silently never existed and every request
 *    refetched everything.
 * 2. **It writes to a temporary file and renames.** Rename is atomic on the same filesystem, so a
 *    concurrent reader never sees a half-written entry.
 * 3. **It is single-flight.** One caller refreshes while the others serve the stale copy, instead
 *    of every request that arrives after expiry stampeding the same upstream.
 * 4. **A failed refresh keeps serving the stale value**, with the reason attached. An expired
 *    answer beats an error page, and the caller can see how old it is and say so.
 *
 * Nothing on npm does all four. `keyv` and friends have neither the single flight nor the
 * serve-stale-on-error, and those two are exactly why this exists.
 *
 * In `src/lib/server/` so SvelteKit's bundler refuses to let it reach the browser: this touches the
 * filesystem and holds locks, and an accidental client import should be a build error rather than a
 * runtime one.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';

/** What a lookup reports back, whether it refreshed, served a copy, or failed holding one. */
export interface CacheEntry<T> {
	/** The value, or null when there was nothing cached and the refresh failed. */
	data: T | null;
	/** How many seconds ago this value was fetched. 0 when it was just now. */
	age: number;
	/** True when `data` is a previous value being served because a refresh did not happen. */
	stale: boolean;
	/** Why the refresh did not happen, or null. Can be set *alongside* a usable `data`. */
	error: string | null;
}

interface StoredEntry {
	at: number;
	data: unknown;
}

/**
 * Turns whatever was on disk into the value the caller expects, or throws.
 *
 * A plain function rather than a schema type, so this module depends on no validation library and
 * stays liftable into a package of its own. `zodSchema.parse` satisfies it as-is.
 */
export type Parse<T> = (value: unknown) => T;

export interface RememberOptions<T> {
	/**
	 * Refresh even when the entry is still fresh — the Reload button.
	 *
	 * It deliberately does not skip the lock: a forced refresh arriving while another caller is
	 * already fetching serves the stale copy rather than making a second call upstream, which is
	 * what stops a held-down Reload becoming a burst of requests.
	 */
	force?: boolean;

	/**
	 * Validates a value read back from disk.
	 *
	 * Without it, a hit is an unchecked assertion: the entry was written by *some* build of this
	 * application, not necessarily this one, and a shape that changed between deploys would be
	 * handed to the caller as the new type. With it, a value that no longer fits is treated as a
	 * miss and refetched, which is the behaviour anybody would have wanted anyway.
	 */
	parse?: Parse<T>;
}

export class Cache {
	readonly #directory: string;

	/**
	 * @param directory where entries live. The default is under the system temp directory, which
	 *   every runtime user can write without an ownership change. The trade is that a restart
	 *   starts cold — for entries that live for seconds to minutes, that is not worth a
	 *   permissions decision to avoid.
	 */
	constructor(directory: string = join(tmpdir(), 'creator-site-cache')) {
		this.#directory = directory;
	}

	/**
	 * The cached value for `key`, refreshed by `refresh` when it is older than `ttl` seconds.
	 *
	 * `force` is the Reload button: it skips the freshness check and refreshes however new the
	 * entry is. It deliberately does **not** skip the lock — a forced refresh arriving while
	 * another caller is already fetching still serves the stale copy rather than making a second
	 * call upstream, which is what stops a held-down Reload becoming a burst of requests. The
	 * answer says `stale` so the page can report that it got the old copy.
	 *
	 * @param ttl seconds
	 */
	async remember<T>(
		key: string,
		ttl: number,
		refresh: () => Promise<T> | T,
		options: RememberOptions<T> = {}
	): Promise<CacheEntry<T>> {
		const { force = false, parse } = options;
		const path = this.#path(key);
		const cached = await this.#reviveEntry(path, parse);
		const age =
			cached === null ? Number.MAX_SAFE_INTEGER : Math.floor(Date.now() / 1000) - cached.at;

		if (!force && cached !== null && age < ttl) {
			return { data: cached.data, age, stale: false, error: null };
		}

		const release = await this.#acquire(path);

		if (release === null) {
			// Someone else is refreshing. Hand back what we have, however old.
			return {
				data: cached?.data ?? null,
				age: cached === null ? 0 : age,
				stale: true,
				error: null
			};
		}

		try {
			const fresh = await refresh();
			await this.#write(path, fresh);

			return { data: fresh, age: 0, stale: false, error: null };
		} catch (cause) {
			return {
				data: cached?.data ?? null,
				age: cached === null ? 0 : age,
				stale: true,
				error: cause instanceof Error ? cause.message : String(cause)
			};
		} finally {
			await release();
		}
	}

	/**
	 * The cached entry for `key`, however old, or null when there is none.
	 *
	 * {@link remember} covers the usual case. This is for the caller that has to decide for itself
	 * whether to refresh — where how long an entry stays good depends on what is in it, or where a
	 * refresh has a per-request budget — so it reports the age and leaves the decision alone.
	 *
	 * The value comes back as `unknown` on purpose. It was read off a disk that an older build of
	 * this application wrote, so the caller either validates it or does not get to claim a type:
	 * `get<T>` would have been a cast wearing a generic's clothes. Pass `parse` to get a typed
	 * value, or validate the result yourself.
	 */
	async get(key: string): Promise<{ data: unknown; age: number } | null>;
	async get<T>(key: string, parse: Parse<T>): Promise<{ data: T; age: number } | null>;
	async get<T>(key: string, parse?: Parse<T>): Promise<{ data: unknown; age: number } | null> {
		const cached = await this.#reviveEntry(this.#path(key), parse);

		if (cached === null) {
			return null;
		}

		return { data: cached.data, age: Math.floor(Date.now() / 1000) - cached.at };
	}

	/** Stores a value for `key`, to be read back with {@link get}. */
	async put(key: string, data: unknown): Promise<void> {
		await this.#write(this.#path(key), data);
	}

	/** Drops one entry, if it exists. Missing is not an error. */
	async forget(key: string): Promise<void> {
		await rm(this.#path(key), { force: true });
	}

	/**
	 * One stored entry, validated if the caller supplied a validator.
	 *
	 * A value that fails validation is reported as a miss rather than as an error: the common cause
	 * is an entry written before a shape changed, and the correct response to that is to refetch,
	 * not to fail the request.
	 */
	async #reviveEntry<T>(
		path: string,
		parse: Parse<T> | undefined
	): Promise<{ at: number; data: T } | null> {
		const stored = await this.#read(path);

		if (stored === null) {
			return null;
		}

		if (parse === undefined) {
			// No validator: the caller has accepted `unknown`, and T is `unknown` with it.
			return { at: stored.at, data: stored.data as T };
		}

		try {
			return { at: stored.at, data: parse(stored.data) };
		} catch {
			return null;
		}
	}

	async #read(path: string): Promise<StoredEntry | null> {
		let raw: string;

		try {
			raw = await readFile(path, 'utf8');
		} catch {
			return null;
		}

		try {
			const decoded: unknown = JSON.parse(raw);

			if (
				typeof decoded !== 'object' ||
				decoded === null ||
				typeof (decoded as StoredEntry).at !== 'number'
			) {
				return null;
			}

			return decoded as StoredEntry;
		} catch {
			// A truncated or corrupt entry is a cache miss, not a crash.
			return null;
		}
	}

	async #write(path: string, data: unknown): Promise<void> {
		if (!(await this.#ensureDirectory())) {
			return;
		}

		let encoded: string;

		try {
			encoded = JSON.stringify({ at: Math.floor(Date.now() / 1000), data } satisfies StoredEntry);
		} catch {
			// Not serialisable — a programming error in the caller, but not a reason to take the
			// request down. The next read is simply a miss.
			return;
		}

		const temporary = `${path}.${String(process.pid)}.tmp`;

		try {
			await writeFile(temporary, encoded, 'utf8');
			// Atomic on the same filesystem, so a reader never sees a partial file.
			await rename(temporary, path);
		} catch {
			await rm(temporary, { force: true });
		}
	}

	/**
	 * A non-blocking exclusive lock, or null when another process holds it.
	 *
	 * `realpath: false` because the file being locked may not exist yet — on a cold cache this is
	 * the first thing that touches the path.
	 */
	async #acquire(path: string): Promise<(() => Promise<void>) | null> {
		if (!(await this.#ensureDirectory())) {
			return null;
		}

		try {
			return await lock(path, { realpath: false, retries: 0, stale: 30_000 });
		} catch {
			return null;
		}
	}

	async #ensureDirectory(): Promise<boolean> {
		try {
			await mkdir(this.#directory, { recursive: true, mode: 0o700 });

			return true;
		} catch {
			return false;
		}
	}

	#path(key: string): string {
		// The key comes from this codebase, never from a request — but hashing it means a path
		// separator could never escape the cache directory even if that stopped being true.
		return join(
			this.#directory,
			`${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`
		);
	}
}
