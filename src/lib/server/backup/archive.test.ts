/**
 * The container format, including the archives it is supposed to refuse.
 *
 * Round-tripping is the easy half and proves the least. The half that matters is everything below
 * `describe('an archive this reader refuses')`: a restore reads a file somebody emailed to an
 * operator who is already having a bad day, so the traversal, symlink and decompression-bomb
 * guards are the reason this module exists in a separate file at all. Those are written through
 * {@link seal} rather than {@link writeArchive}, because `writeArchive` correctly refuses to
 * produce them — and a guard whose adversarial case cannot be constructed is a comment.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pack as makePack } from 'tar-stream';
import {
	ArchiveRefusal,
	FORMAT,
	HEADER_BYTES,
	MAGIC,
	TAG_BYTES,
	isSafeName,
	readArchive,
	seal,
	writeArchive
} from './archive.js';
import type { ArchiveProblem } from './archive.js';

const PASSWORD = 'correct horse battery staple';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'creator-archive-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** The archive under test, named once so every case reads the same. */
function archive(name = 'backup.crsbak'): string {
	return join(directory, name);
}

/** Everything in an archive, as a map, by reading it the way a restore would. */
async function contentsOf(path: string, password = PASSWORD): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();

	await readArchive(path, password, async (name, body) => {
		const chunks: Buffer[] = [];

		for await (const chunk of body) chunks.push(chunk as Buffer);

		found.set(name, Buffer.concat(chunks));
	});

	return found;
}

/** The problem an archive is refused with, or `null` when it was not refused. */
async function problemOf(
	path: string,
	password = PASSWORD,
	limits?: Parameters<typeof readArchive>[3]
): Promise<ArchiveProblem | null> {
	try {
		await readArchive(
			path,
			password,
			async (_name, body) => {
				// Drained rather than ignored: tar is sequential, so an unread entry stalls the read and
				// a limit breach on a *later* member would never be reached.
				for await (const chunk of body) expect(chunk).toBeDefined();
			},
			limits
		);

		return null;
	} catch (cause) {
		if (cause instanceof ArchiveRefusal) return cause.problem;

		throw cause;
	}
}

/** A tar stream of exactly the members given, including ones `writeArchive` would refuse. */
function tarOf(
	members: readonly { readonly name: string; readonly body?: string; readonly type?: string }[]
): Readable {
	const pack = makePack();

	for (const member of members) {
		const body = member.body ?? '';

		pack.entry(
			{
				name: member.name,
				size: body.length,
				...(member.type === undefined ? {} : { type: member.type as 'file', linkname: 'x' })
			},
			body
		);
	}

	pack.finalize();

	return Readable.from(pack);
}

describe('round-tripping', () => {
	it('gives back every entry, byte for byte, in the order written', async () => {
		await writeArchive(archive(), PASSWORD, [
			{ name: 'manifest.json', body: Buffer.from('{"format":1}') },
			{ name: 'config/site.json', body: Buffer.from('{"name":"a site"}') },
			{ name: 'config/feed.json', body: Buffer.from('{"limit":20}') }
		]);

		const found = await contentsOf(archive());

		expect([...found.keys()]).toStrictEqual([
			'manifest.json',
			'config/site.json',
			'config/feed.json'
		]);
		expect(found.get('config/site.json')?.toString()).toBe('{"name":"a site"}');
	});

	it('carries an empty entry, which is a legitimate empty config document', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'empty', body: Buffer.alloc(0) }]);

		expect((await contentsOf(archive())).get('empty')?.length).toBe(0);
	});

	it('streams a file-backed entry rather than taking its bytes', async () => {
		// Five megabytes of random data: random so compression cannot hide a truncation, and large
		// enough to cross several stream buffers, which is where an off-by-one in the framing shows.
		const bytes = randomBytes(5 * 1024 * 1024);
		const source = join(directory, 'database.sqlite');

		await writeFile(source, bytes);
		await writeArchive(archive(), PASSWORD, [
			{ name: 'database.sqlite', body: { file: source, bytes: bytes.length } }
		]);

		const restored = (await contentsOf(archive())).get('database.sqlite');

		expect(restored?.length).toBe(bytes.length);
		expect(
			createHash('sha256')
				.update(restored ?? Buffer.alloc(0))
				.digest('hex')
		).toBe(createHash('sha256').update(bytes).digest('hex'));
	});

	it('compresses, which is the point of the gzip step', async () => {
		// Compressible on purpose. Asserting a ratio on arbitrary data would be asserting something
		// about zlib; asserting that repetitive input shrinks is asserting that the step is wired in
		// at all, which is what a missing `createGzip` would break while everything still worked.
		await writeArchive(archive(), PASSWORD, [
			{ name: 'repetitive', body: Buffer.alloc(200_000, 7) }
		]);

		expect((await stat(archive())).size).toBeLessThan(10_000);
	});

	it('writes a header this format can be recognised by', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const head = (await readFile(archive())).subarray(0, HEADER_BYTES);

		expect(head.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
		expect(head.readUInt8(6)).toBe(FORMAT);

		// The salt and the IV are random per archive, so neither may be a block of zeroes — which is
		// what a `Buffer.alloc` that never got filled would leave, and what would make every archive
		// written by this build share a key stream.
		expect(head.subarray(13, 45).equals(Buffer.alloc(32))).toBe(false);
		expect(head.subarray(45, 57).equals(Buffer.alloc(12))).toBe(false);
	});

	it('uses a different salt and IV for every archive, on the same password and contents', async () => {
		const entries = [{ name: 'a', body: Buffer.from('identical') }];

		await writeArchive(archive('one'), PASSWORD, entries);
		await writeArchive(archive('two'), PASSWORD, entries);

		const one = await readFile(archive('one'));
		const two = await readFile(archive('two'));

		// Each field compared on its own, which is the whole lesson from this test's first version.
		// It asserted that the two files differed and that their ciphertexts differed, which both
		// hold as soon as the *salt* is random — so a build with a hard-coded IV passed it. Nonce
		// reuse under a reused key is the failure that leaks plaintext between two backups, and
		// nothing in a whole-file comparison can see it.
		expect(one.subarray(13, 45).equals(two.subarray(13, 45))).toBe(false);
		expect(one.subarray(45, 57).equals(two.subarray(45, 57))).toBe(false);
		expect(one.subarray(HEADER_BYTES).equals(two.subarray(HEADER_BYTES))).toBe(false);
	});
});

describe('a name that may be joined onto a directory', () => {
	it.each([
		['an ordinary name', 'manifest.json'],
		['a name in a directory', 'config/site.json'],
		['a deep name', 'uploads/2026/10/a-file.png'],
		['a directory, which tar spells with a trailing slash', 'config/'],
		['a name containing a dot', 'site.v2.json'],
		['a name containing dots in a part', '..hidden'],
		['a space', 'my backup.json']
	])('allows %s', (_what, name) => {
		expect(isSafeName(name)).toBe(true);
	});

	it.each([
		['nothing', ''],
		['a traversal', '../etc/passwd'],
		['a traversal in the middle', 'config/../../etc/passwd'],
		['a bare traversal', '..'],
		['a current-directory part', './config/site.json'],
		['an absolute path', '/etc/passwd'],
		['a doubled separator', 'config//site.json'],
		['a Windows separator, which is a separator there and a traversal here', 'config\\..\\x'],
		['a Windows drive', 'C:/windows/x'],
		['an overlong name', `${'a'.repeat(256)}.json`]
	])('refuses %s', (_what, name) => {
		expect(isSafeName(name)).toBe(false);
	});

	it('refuses a name carrying a control character', () => {
		// Built from code points rather than written as an escape, for the reason stated in the
		// module: an escape in source does not survive every tool that touches the file.
		expect(isSafeName(`config${String.fromCodePoint(0)}.json`)).toBe(false);
		expect(isSafeName(`config${String.fromCodePoint(10)}.json`)).toBe(false);
		expect(isSafeName(`config${String.fromCodePoint(127)}.json`)).toBe(false);
	});

	it('refuses to write an entry it would refuse to read', async () => {
		await expect(
			writeArchive(archive(), PASSWORD, [{ name: '../escape', body: Buffer.from('x') }])
		).rejects.toThrow(ArchiveRefusal);
	});
});

describe('an archive this reader refuses', () => {
	it('reports a wrong password without claiming to know it was the password', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		expect(await problemOf(archive(), 'not the password')).toBe('wrong_password_or_corrupt');
	});

	it('reports a single flipped ciphertext byte the same way', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b'.repeat(5000)) }]);

		const bytes = await readFile(archive());

		bytes.writeUInt8(bytes.readUInt8(HEADER_BYTES + 4) ^ 1, HEADER_BYTES + 4);
		await writeFile(archive(), bytes);

		expect(await problemOf(archive())).toBe('wrong_password_or_corrupt');
	});

	it('refuses a header whose salt was substituted, because the header is authenticated', async () => {
		// The reason the key-derivation parameters can safely be written into the file. Without the
		// header as AAD this would decrypt to garbage under a key the attacker chose the salt for.
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const bytes = await readFile(archive());

		randomBytes(32).copy(bytes, 13);
		await writeFile(archive(), bytes);

		expect(await problemOf(archive())).toBe('wrong_password_or_corrupt');
	});

	it('refuses a header asking for more key-derivation work than it will do', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const bytes = await readFile(archive());

		bytes.writeUInt32BE(0x4000_0000, 7);
		await writeFile(archive(), bytes);

		// Not `wrong_password_or_corrupt`: the point is that it is refused *before* anything tries to
		// allocate a gigabyte of scrypt memory for it.
		expect(await problemOf(archive())).toBe('unreasonable_parameters');
	});

	it('refuses a header whose N is not a power of two', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const bytes = await readFile(archive());

		bytes.writeUInt32BE(100_000, 7);
		await writeFile(archive(), bytes);

		// scrypt throws on this rather than returning, so without the check it would surface as an
		// internal error on a file that is merely damaged.
		expect(await problemOf(archive())).toBe('unreasonable_parameters');
	});

	it('refuses a file that is not an archive at all', async () => {
		await writeFile(archive(), Buffer.alloc(500, 0x41));

		expect(await problemOf(archive())).toBe('not_an_archive');
	});

	it('refuses a file too short to hold a header and a tag', async () => {
		await writeFile(archive(), MAGIC);

		expect(await problemOf(archive())).toBe('not_an_archive');
	});

	it('refuses an archive from a newer format, by name', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const bytes = await readFile(archive());

		bytes.writeUInt8(FORMAT + 1, 6);
		await writeFile(archive(), bytes);

		expect(await problemOf(archive())).toBe('unsupported_format');
	});

	it('refuses an archive whose tag was replaced', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		const bytes = await readFile(archive());

		randomBytes(TAG_BYTES).copy(bytes, bytes.length - TAG_BYTES);
		await writeFile(archive(), bytes);

		expect(await problemOf(archive())).toBe('wrong_password_or_corrupt');
	});

	it('refuses a member whose name traverses out of wherever it is being written', async () => {
		await seal(archive(), PASSWORD, tarOf([{ name: '../../etc/cron.d/backdoor', body: 'x' }]));

		expect(await problemOf(archive())).toBe('unsafe_entry');
	});

	it('refuses a symlink member rather than skipping it', async () => {
		// Skipping is the tempting choice, and it is the wrong one: a restore that drops the member
		// and reports success is worse than one that says what it found.
		await seal(archive(), PASSWORD, tarOf([{ name: 'config/site.json', type: 'symlink' }]));

		expect(await problemOf(archive())).toBe('unsafe_member');
	});

	it('refuses a hard link member', async () => {
		await seal(archive(), PASSWORD, tarOf([{ name: 'config/site.json', type: 'link' }]));

		expect(await problemOf(archive())).toBe('unsafe_member');
	});

	it('refuses a directory member, because nothing in this format needs one', async () => {
		await seal(archive(), PASSWORD, tarOf([{ name: 'config/', type: 'directory' }]));

		expect(await problemOf(archive())).toBe('unsafe_member');
	});

	it('stops at the entry that breaches the count limit', async () => {
		await writeArchive(
			archive(),
			PASSWORD,
			Array.from({ length: 5 }, (_unused, index) => ({
				name: `file-${String(index)}`,
				body: Buffer.from('x')
			}))
		);

		expect(
			await problemOf(archive(), PASSWORD, {
				maxEntries: 3,
				maxEntryBytes: 1024,
				maxTotalBytes: 1024
			})
		).toBe('too_large');
	});

	it('refuses one member larger than the per-entry limit', async () => {
		await writeArchive(archive(), PASSWORD, [{ name: 'big', body: Buffer.alloc(50_000, 1) }]);

		expect(
			await problemOf(archive(), PASSWORD, {
				maxEntries: 10,
				maxEntryBytes: 10_000,
				maxTotalBytes: 10_000_000
			})
		).toBe('too_large');
	});

	it('refuses members that are individually fine and together are not', async () => {
		// The decompression-bomb case: every member passes its own check, and the archive still
		// expands to more than the caller agreed to write.
		await writeArchive(archive(), PASSWORD, [
			{ name: 'a', body: Buffer.alloc(8_000, 1) },
			{ name: 'b', body: Buffer.alloc(8_000, 2) },
			{ name: 'c', body: Buffer.alloc(8_000, 3) }
		]);

		expect(
			await problemOf(archive(), PASSWORD, {
				maxEntries: 10,
				maxEntryBytes: 10_000,
				maxTotalBytes: 20_000
			})
		).toBe('too_large');
	});

	it('does not refuse an archive that sits exactly on its limits', async () => {
		await writeArchive(archive(), PASSWORD, [
			{ name: 'a', body: Buffer.alloc(100, 1) },
			{ name: 'b', body: Buffer.alloc(100, 2) }
		]);

		expect(
			await problemOf(archive(), PASSWORD, {
				maxEntries: 2,
				maxEntryBytes: 100,
				maxTotalBytes: 200
			})
		).toBeNull();
	});

	it('surfaces what the sink threw rather than reporting it as a damaged file', async () => {
		// A restore's sink fails for its own reasons — a full disk, a schema mismatch — and reporting
		// that as "the password is wrong or the file is damaged" would send the operator after the
		// wrong problem entirely.
		await writeArchive(archive(), PASSWORD, [{ name: 'a', body: Buffer.from('b') }]);

		await expect(
			readArchive(archive(), PASSWORD, () => Promise.reject(new Error('no space left on device')))
		).rejects.toThrow(/no space left on device/);
	});
});
