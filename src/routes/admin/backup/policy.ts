/**
 * The rules both halves of the backup page share.
 *
 * Its own module so the download route and the restore action cannot drift apart on them. A
 * download that demanded twelve characters while the restore accepted four would be a rule that
 * only applies to the person who follows it.
 */

/**
 * The shortest password a *new* backup may be given.
 *
 * Twelve, and the reasoning is worth stating because the number looks arbitrary: the archive is the
 * entire database — every session token, every stored credential — and the password is the only
 * thing protecting it once the file leaves this machine for whatever the operator keeps backups on.
 * scrypt at the cost this format uses makes an offline guess expensive, which buys a short password
 * time and not safety.
 *
 * Length only. A composition rule ("one digit, one symbol") would push operators towards
 * `Password1!` while refusing a passphrase that is genuinely stronger, and the archive format has
 * no way to tell the difference.
 *
 * Deliberately **not** applied when restoring: there the password is whatever the archive was
 * written with, and refusing to try a short one would lock somebody out of their own backup over a
 * rule that was introduced after they made it.
 */
export const MINIMUM_PASSWORD = 12;

/**
 * The largest upload the restore form will accept, in bytes.
 *
 * This is a *second* limit. The first belongs to the adapter: `adapter-node` refuses a request body
 * over `BODY_SIZE_LIMIT`, which defaults to 512 KiB — small enough that the first real restore
 * would fail with a message about the request rather than about the backup. An install that wants
 * this page to work has to raise it, and `README.md` says so.
 *
 * Checked here as well because the adapter's limit is an operator's setting and might be `Infinity`,
 * and an unbounded upload into a form parser is an unbounded allocation.
 */
export const MAXIMUM_UPLOAD = 512 * 1024 * 1024;
