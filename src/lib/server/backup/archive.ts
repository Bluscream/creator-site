/**
 * The backup container: a password-protected, compressed archive of named entries.
 *
 * This module knows nothing about what a backup of this install contains — no SQLite, no
 * configuration documents, no uploads. It takes named byte streams in and gives named byte streams
 * back, and everything it enforces is a property of the *container*. `./index.ts` decides what goes
 * inside. The seam is worth having because the two halves fail for completely different reasons: a
 * wrong password is not a schema mismatch, and debugging one while reading code about the other is
 * how a restore ends up half-applied.
 *
 * ### The format
 *
 * `tar` → `gzip -9` → `AES-256-GCM`, all from `node:zlib` and `node:crypto` plus `tar-stream`, so
 * restoring needs nothing installed on the machine that is probably already broken. Layout:
 *
 * ```text
 * offset  bytes  field
 *      0      6  magic, "CRSBAK"
 *      6      1  format version
 *      7      4  scrypt N, big-endian
 *     11      1  scrypt r
 *     12      1  scrypt p
 *     13     32  scrypt salt
 *     45     12  AES-GCM initialisation vector
 *     57      …  ciphertext
 *     -16    16  AES-GCM authentication tag
 * ```
 *
 * **The whole header is the AAD**, which is the point of writing the key-derivation parameters down
 * rather than hard-coding them: a future session can raise the scrypt cost without orphaning every
 * archive written before it, and an attacker still cannot hand the reader a header with a weakened
 * `N` or a substituted salt, because changing any byte of it breaks the tag.
 *
 * ### The tag is at the end, and is needed at the start
 *
 * GCM produces its tag after the last byte of plaintext, but `createDecipheriv` needs it before
 * `final()`. For a stream that is a genuine problem; for a file it is not, so the reader seeks to
 * the last sixteen bytes first and then streams the middle. The consequence is deliberate and worth
 * stating: **this format is not restorable from a pipe**, only from a seekable file.
 *
 * ### What authentication does and does not buy
 *
 * A valid tag means the bytes are exactly what was written under this password. It does *not* mean
 * the contents make sense, so `./index.ts` still verifies a manifest. And because GCM cannot tell
 * "you typed the wrong password" apart from "the file is damaged" — both are just a key that does
 * not reproduce the tag — there is one refusal covering both, rather than a guess presented as a
 * diagnosis.
 *
 * ### Decompression is capped
 *
 * `gzip` expands, so an attacker-supplied archive is a disk-filling tool unless somebody counts.
 * Entries, per-entry bytes and total bytes are all limited, the reader stops at the first breach,
 * and the limits are the caller's to raise for a restore it has reason to trust.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { extract as makeExtract, pack as makePack } from 'tar-stream';

/**
 * `crypto.scrypt`, awaited.
 *
 * Wrapped by hand rather than with `promisify`, which resolves to the four-argument overload and
 * drops the `options` parameter — the one carrying `N`, `r`, `p` and `maxmem`, which is the entire
 * reason this is here. The alternative was a cast asserting a signature the types disagreed with.
 */
function scrypt(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password, salt, keylen, options, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});
}

/** Identifies the format on sight, so a wrong file is named as one rather than failing as crypto. */
export const MAGIC = Buffer.from('CRSBAK', 'ascii');

/** The format this build writes. A reader refuses anything it does not know. */
export const FORMAT = 1;

/** Fixed-size prefix, per the layout above. */
export const HEADER_BYTES = 57;

/** AES-GCM's tag, appended after the ciphertext. */
export const TAG_BYTES = 16;

/**
 * Key-derivation cost, written into every archive.
 *
 * `N = 2^17` with `r = 8, p = 1` is the current OWASP recommendation for scrypt, and costs about
 * 128 MiB and a fraction of a second — which is the right trade for a file that is written once,
 * read once in an emergency, and otherwise sits somewhere a password is the only thing protecting
 * it. `maxmem` has to be raised to match, because Node's default refuses anything over 32 MiB.
 */
export const SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;

/**
 * The largest `N` a *reader* will honour.
 *
 * Without this, a hostile header is a memory-exhaustion request: `N` is four bytes, so the file
 * could ask for terabytes before the password is even wrong. Two doublings of headroom above what
 * is written, so raising {@link SCRYPT} stays possible without a format break.
 */
const MAX_N = 1 << 19;

/** How much a reader will unpack unless the caller says otherwise. */
export interface ArchiveLimits {
	readonly maxEntries: number;
	readonly maxEntryBytes: number;
	readonly maxTotalBytes: number;
}

/** Generous for a configuration-and-database backup, finite against a crafted one. */
export const DEFAULT_LIMITS: ArchiveLimits = {
	maxEntries: 10_000,
	maxEntryBytes: 2 * 1024 * 1024 * 1024,
	maxTotalBytes: 4 * 1024 * 1024 * 1024
};

/** Why an archive could not be written or read. */
export type ArchiveProblem =
	/** Not this format at all — the magic does not match, or the file is shorter than a header. */
	| 'not_an_archive'
	/** This format, from a newer build. */
	| 'unsupported_format'
	/** The key does not reproduce the tag: a wrong password, or damaged bytes. Indistinguishable. */
	| 'wrong_password_or_corrupt'
	/** The header asks for more key-derivation work than a reader will do. */
	| 'unreasonable_parameters'
	/** Unpacking it would exceed {@link ArchiveLimits}. */
	| 'too_large'
	/** An entry name that would write outside wherever the caller is putting things. */
	| 'unsafe_entry'
	/** A member that is not a plain file or directory — a symlink, a device, a hard link. */
	| 'unsafe_member';

/** Thrown for anything the container itself refuses. */
export class ArchiveRefusal extends Error {
	constructor(
		readonly problem: ArchiveProblem,
		message: string,
		options?: { readonly cause?: unknown }
	) {
		super(message, options);
		this.name = 'ArchiveRefusal';
	}
}

/**
 * One entry going in.
 *
 * A body is either bytes already in hand — a generated manifest — or a file to stream, because the
 * database is the largest thing in a backup and reading it into memory to hand it to a compressor
 * that is about to stream it anyway would be the one allocation that scales with the install.
 */
export interface ArchiveEntry {
	readonly name: string;
	readonly body: Buffer | { readonly file: string; readonly bytes: number };
}

/**
 * Receives one entry coming out.
 *
 * A callback rather than an async iterator so that backpressure is the caller's, and an entry that
 * is written straight to disk never has to exist in memory. The sink must consume `body`: tar is
 * sequential, so an unread entry stalls the whole read.
 */
export type EntrySink = (name: string, body: Readable) => Promise<void>;

/**
 * Whether a name may be joined onto a directory.
 *
 * Every name in an archive is attacker-controlled — that is what "restore a file somebody sent you"
 * means — and `path.join(dir, name)` with `../../etc/cron.d/x` is the classic tar extraction bug.
 * This is an allow-list of shape: POSIX-style relative paths of ordinary characters. Backslashes
 * are refused rather than normalised, because on Windows they are separators and treating them as
 * literal characters is how a traversal gets through a check that only looked for `/`.
 */
export function isSafeName(name: string): boolean {
	if (name === '' || name.length > 255) return false;
	if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
	// By code point rather than a character class, because writing one means writing a `\u0000`
	// escape in source — and an escape like that becomes a real control byte on its way through any
	// tool that unescapes strings, which silently changes what the check means. It also avoids a
	// suppression for `no-control-regex`, the rule that objects to exactly this pattern.
	for (const character of name) {
		const code = character.codePointAt(0) ?? 0;

		if (code < 0x20 || code === 0x7f) return false;
	}

	const parts = name.split('/');

	// A trailing slash is how tar spells a directory, so one empty final part is allowed; an empty
	// part anywhere else is `//`, and `.` or `..` is a traversal or a no-op. A *leading* empty part
	// cannot reach here — that is an absolute path, refused above.
	return parts.every(
		(part, index) => part !== '.' && part !== '..' && (part !== '' || index === parts.length - 1)
	);
}

/**
 * Whatever a sink threw, as something that can be thrown again.
 *
 * A sink is caller code and may throw anything at all; a value that is not an `Error` has already
 * lost its stack by the time it gets here, so wrapping it keeps the message rather than inventing
 * one. The alternative — declaring the recorded value as `Error` — would be a lie about what a
 * callback can do.
 */
function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** The header for a new archive, with a fresh salt and IV. */
function buildHeader(): Buffer {
	const header = Buffer.alloc(HEADER_BYTES);

	MAGIC.copy(header, 0);
	header.writeUInt8(FORMAT, 6);
	header.writeUInt32BE(SCRYPT.N, 7);
	header.writeUInt8(SCRYPT.r, 11);
	header.writeUInt8(SCRYPT.p, 12);
	randomBytes(32).copy(header, 13);
	randomBytes(12).copy(header, 45);

	return header;
}

/** The key a header's parameters describe. */
async function keyFor(header: Buffer, password: string): Promise<Buffer> {
	const N = header.readUInt32BE(7);
	const r = header.readUInt8(11);
	const p = header.readUInt8(12);

	// `N` must be a power of two or scrypt throws; checking here turns a crash on a corrupt byte
	// into the refusal it actually is.
	if (N < 1024 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
		throw new ArchiveRefusal(
			'unreasonable_parameters',
			'this archive asks for key-derivation work outside what this build will do, so it is damaged or was not written by this software'
		);
	}

	return scrypt(password, header.subarray(13, 45), 32, {
		N,
		r,
		p,
		// Scaled from the parameters rather than fixed, so the ceiling is `MAX_N` and nothing else.
		maxmem: 256 * MAX_N * r
	});
}

/**
 * Compresses, encrypts and frames an arbitrary tar stream into a file.
 *
 * The header goes down first in the clear — it has to, since it carries the salt needed to derive
 * the key that reads the rest — then the ciphertext, then the tag. `end: false` on the pipeline is
 * what makes the last part possible: letting it close the file would leave nowhere to put the tag.
 *
 * Separate from {@link writeArchive}, and exported, for two reasons. It is the honest seam — this
 * function is the container and {@link writeArchive} is a convenience for assembling one — and it
 * is the only way to produce an archive whose *contents* are hostile. The reader refuses symlinks,
 * traversing names and oversized members, and a test cannot exercise any of that through an API
 * that refuses to write them in the first place. A guard with no adversarial test is a comment.
 *
 * @param path where to write. Overwritten if it exists, so the caller picks a name it means.
 * @param password the only thing protecting the contents. Not checked for strength here; that is a
 *   decision for whoever is asking the operator for it, not for the byte layer.
 */
export async function seal(path: string, password: string, tar: Readable): Promise<void> {
	const header = buildHeader();
	const key = await keyFor(header, password);
	const cipher = createCipheriv('aes-256-gcm', key, header.subarray(45, 57));

	cipher.setAAD(header);

	const out = createWriteStream(path);

	out.write(header);

	await pipeline(tar, createGzip({ level: 9 }), cipher, out, { end: false });

	await new Promise<void>((resolve, reject) => {
		out.end(cipher.getAuthTag(), () => {
			resolve();
		});
		out.on('error', reject);
	});
}

/** Writes an archive of the given entries. See {@link seal} for the format. */
export async function writeArchive(
	path: string,
	password: string,
	entries: readonly ArchiveEntry[]
): Promise<void> {
	for (const entry of entries) {
		if (!isSafeName(entry.name)) {
			throw new ArchiveRefusal('unsafe_entry', `'${entry.name}' is not a name this format holds`);
		}
	}

	const pack = makePack();

	// Filled while `seal` drains it. Sequential by construction: `pack.entry` with a body returns
	// once that entry is written, so the file streams are not all open at once. Both halves have to
	// be in flight together, or the first entry large enough to fill a buffer deadlocks.
	const feed = async (): Promise<void> => {
		for (const entry of entries) {
			if (Buffer.isBuffer(entry.body)) {
				pack.entry({ name: entry.name, size: entry.body.length }, entry.body);
				continue;
			}

			const sink = pack.entry({ name: entry.name, size: entry.body.bytes });

			await pipeline(createReadStream(entry.body.file), sink);
		}

		pack.finalize();
	};

	await Promise.all([feed(), seal(path, password, Readable.from(pack))]);
}

/** The fixed prefix and trailing tag of an existing archive, with the format checked. */
async function readFraming(
	path: string
): Promise<{ readonly header: Buffer; readonly tag: Buffer; readonly size: number }> {
	const handle = await open(path, 'r');

	try {
		const { size } = await handle.stat();

		if (size < HEADER_BYTES + TAG_BYTES) {
			throw new ArchiveRefusal('not_an_archive', 'this file is too short to be a backup');
		}

		const header = Buffer.alloc(HEADER_BYTES);
		const tag = Buffer.alloc(TAG_BYTES);

		await handle.read(header, 0, HEADER_BYTES, 0);
		await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);

		if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
			throw new ArchiveRefusal(
				'not_an_archive',
				'this file is not a backup written by this software'
			);
		}

		const format = header.readUInt8(6);

		if (format > FORMAT) {
			throw new ArchiveRefusal(
				'unsupported_format',
				`this backup is format ${String(format)} and this build reads up to ${String(FORMAT)}: it was written by a newer version`
			);
		}

		return { header, tag, size };
	} finally {
		await handle.close();
	}
}

/**
 * Reads an archive, handing each entry to `sink` in the order it was written.
 *
 * Directories and anything that is not a plain file are refused rather than skipped. Skipping is
 * the tempting choice — they carry no data — but an archive containing a symlink is either damaged
 * or an attempt, and a restore that quietly drops the interesting member and reports success is the
 * failure mode worth avoiding.
 */
export async function readArchive(
	path: string,
	password: string,
	sink: EntrySink,
	limits: ArchiveLimits = DEFAULT_LIMITS
): Promise<void> {
	const { header, tag, size } = await readFraming(path);
	const key = await keyFor(header, password);
	const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(45, 57));

	decipher.setAAD(header);
	decipher.setAuthTag(tag);

	let count = 0;
	let total = 0;

	/**
	 * Why the read was abandoned, when it was abandoned on purpose.
	 *
	 * Recorded rather than thrown. Throwing out of the `entry` handler looked right and was not: the
	 * handler is called from inside the extractor's own write, so the rejection arrives both as the
	 * pipeline's failure *and* as an unhandled rejection, and vitest reported four passing refusals
	 * as uncaught exceptions. Destroying the stream and re-throwing afterwards keeps one path.
	 */
	let stopped: unknown = null;

	const extract = makeExtract();

	/** Why this member may not be unpacked, or null. Pure, so the handler below stays readable. */
	const refuse = (entry: {
		readonly name: string;
		readonly type: string;
		readonly size: number;
	}) => {
		if (entry.type !== 'file') {
			return new ArchiveRefusal(
				'unsafe_member',
				`this backup contains '${entry.name}' as a ${entry.type}, which a restore will not write`
			);
		}

		if (!isSafeName(entry.name)) {
			return new ArchiveRefusal(
				'unsafe_entry',
				`this backup contains '${entry.name}', which is not a path a restore will write`
			);
		}

		count += 1;
		total += entry.size;

		if (
			count > limits.maxEntries ||
			total > limits.maxTotalBytes ||
			entry.size > limits.maxEntryBytes
		) {
			return new ArchiveRefusal(
				'too_large',
				'this backup unpacks to more than this build will extract'
			);
		}

		return null;
	};

	extract.on('entry', (entry, body, next) => {
		void (async () => {
			const refusal = refuse({ name: entry.name, type: entry.type, size: entry.size });

			if (refusal !== null) {
				stopped = refusal;
				extract.destroy();

				return;
			}

			try {
				await sink(entry.name, Readable.from(body));
				next();
			} catch (cause) {
				stopped = cause;
				extract.destroy();
			}
		})();
	});

	try {
		await pipeline(
			createReadStream(path, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
			decipher,
			createGunzip(),
			extract
		);
	} catch (cause) {
		// A deliberate stop comes first: destroying the extractor makes the pipeline reject with a
		// premature-close error, which says nothing about why.
		if (stopped !== null) throw asError(stopped);

		// Everything the crypto and compression layers throw here means the same thing, and the
		// messages they use ("unable to authenticate data", "incorrect header check") read as bugs
		// rather than as the one question the operator can act on.
		throw new ArchiveRefusal(
			'wrong_password_or_corrupt',
			'this backup could not be opened: either the password is wrong or the file is damaged',
			{ cause }
		);
	}

	// Belt and braces: if a future tar-stream resolved the pipeline despite a destroy, a recorded
	// refusal must still not be reported as a successful restore.
	if (stopped !== null) throw asError(stopped);
}
