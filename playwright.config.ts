/**
 * The browser tests, against a built server.
 *
 * The server is started through `scripts/e2e-server.js` rather than `vite` directly, and that is
 * what makes these tests mean anything: the script clears every variable `.env.example` declares
 * and sets the handful the test install needs, so the suite asserts a known configuration instead
 * of whatever the machine happens to be set up as.
 *
 * Without it, "an unconfigured install offers no sign-in button" was really asserting "this
 * developer has no credentials for any sign-in platform" — true for months, then false the moment
 * Twitch was added, and only on the machine whose shell exported them.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'node scripts/e2e-server.js',
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
