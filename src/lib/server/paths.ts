/**
 * Where this installation keeps the things it writes.
 *
 * One module, because three of them were about to each hold `process.env.DATA_DIR ?? 'data'` and a
 * default that is only *mostly* the same in three places is the kind of thing that stays unnoticed
 * until one of them writes somewhere else.
 *
 * ### Why the environment is read directly, and at call time
 *
 * Not through `config.ts`: the log is one of the consumers, and a configuration layer that can fail
 * must not be on the path to the thing that would report the failure.
 *
 * Read on every call rather than captured once at module load, so a test can set `DATA_DIR` to a
 * temporary directory and have it take effect. Captured at load, the first import in a test run
 * would fix the path for every suite after it.
 */

import { join } from 'node:path';

/** The name of the data directory when nothing says otherwise: relative to the working directory. */
const DEFAULT_DATA_DIR = 'data';

/**
 * The directory holding the database, the log, the cache and the configuration document.
 *
 * Never web-reachable. SvelteKit serves no directory by itself, but a data directory that could be
 * fetched would hand out a log of other people's requests, so the container keeps this on a volume
 * outside the application root.
 */
export function dataDir(): string {
	return process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
}

/** A path inside {@link dataDir}. */
export function dataPath(...segments: readonly string[]): string {
	return join(dataDir(), ...segments);
}
