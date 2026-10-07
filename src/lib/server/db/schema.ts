/**
 * The database schema.
 *
 * **Deliberately empty.** Nothing persists yet: the live, chat and activity feeds are cached to
 * files by `src/lib/server/cache.ts`, which is the right store for values that live for seconds,
 * and everything else that needs a table belongs to a stage that has not happened.
 *
 * What was here was the SvelteKit scaffold's `task` table, with `title` and `priority` columns.
 * Nothing imported it, and it would have been created in every install the first time anyone ran
 * `db:push`. A table in somebody's database that no code reads is worse than no table: it looks
 * like a feature that broke.
 *
 * ### What goes in, and when
 *
 * From §6 of the architecture notes, in the order the stages reach them:
 *
 * | stage | tables |
 * | --- | --- |
 * | 4 | cached feed posts, and the per-source fetch state that decides when to try a source again |
 * | 5 | accounts, linked identities, permissions, sessions if they outgrow the cookie |
 * | 5 | settings the admin edits — provider credentials, encrypted at rest |
 * | 6 | calendar events |
 * | 8 | link-click metrics |
 * | — | the admin's audit trail, alongside whatever first writes to it |
 *
 * The config *document* stays a file. It is the thing a creator edits, diffs and backs up, and a
 * row in SQLite is none of those.
 *
 * `drizzle.config.ts` points here, so `npm run db:push` is a no-op against this file. That is the
 * intended state until a table has code that reads it.
 */

export {};
