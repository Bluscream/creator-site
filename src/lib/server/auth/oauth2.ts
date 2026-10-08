/**
 * The OAuth 2.0 authorization code flow, once, for every provider.
 *
 * ### Why this module exists at all
 *
 * It replaces `arctic`, which was **deprecated on 2026-07-29 with no successor package** — the
 * author's advice is to copy example code out of the repository. That is not a dependency to keep on
 * the path that issues sessions: the next time a provider changes a detail, nobody upstream fixes it.
 *
 * The exposure was small, because `./sign-in-provider.ts` had already contained it to three call
 * sites. What `arctic` actually supplied was two things: the protocol, and a table of per-provider
 * endpoints. The protocol moves here, onto `oauth4webapi` — maintained, zero-dependency, and strict
 * about the specification. The endpoints move into each platform's own module, which is where that
 * platform's *other* endpoints already live: Twitch's `/oauth2/validate` and `helix/users` were
 * already hand-written next to each other, so this consolidates rather than scatters.
 *
 * ### Not hand-rolled, deliberately
 *
 * It would be about sixty lines to build the two requests by hand. The reason not to is everything
 * the specification requires that those sixty lines would omit: that `token_type` is checked, that an
 * error response is distinguished from a successful one with an `error` field in it, that unexpected
 * parameters are rejected rather than ignored, that the state comparison is not an early-exit string
 * compare. Getting a subset of that right is how an auth bug ships looking finished.
 *
 * ### Providers do not agree, so quirks are per provider
 *
 * Two differences are real and were measured against each provider rather than assumed:
 *
 * - **Client authentication.** Both providers here send the secret in the form body, but for
 *   different reasons, and other platforms require an HTTP Basic header — so it stays per provider.
 *   {@link ClientAuth} records the encoding hazard that makes the two not interchangeable.
 * - **Twitch's `scope`.** Twitch answers the token endpoint with `scope` as a JSON **array**. RFC
 *   6749 §5.1 requires a space-delimited **string**, and a specification-exact library refuses the
 *   response outright: `"response" body "scope" property must be a string`. So a provider may declare
 *   {@link Quirk.spaceDelimitedScope} and the array is joined before the response is processed.
 *
 * Both are declared by the platform rather than sniffed, so a provider that is wrong about itself
 * fails at its own module rather than somewhere in here.
 *
 * ### The state check is here *and* in the flow, on purpose
 *
 * `oauth4webapi` will not accept callback parameters that did not come from its own
 * `validateAuthResponse`, which is a good guard: it makes skipping the state comparison impossible
 * rather than merely inadvisable. But it can only compare the value it is handed, so on its own it
 * proves nothing — the check that matters is `flow.ts` comparing the callback's state to the one in
 * the cookie, because that is what binds the response to *this browser*.
 *
 * So the expected state passed in here is the **cookie's**, not the callback's, and the library is
 * then doing real work: it rejects an `error=` response, a missing code and duplicated parameters,
 * none of which the cookie comparison looks at.
 *
 * ### What an error here may say
 *
 * Only which of two things happened: the provider refused, or it could not be reached. Never a
 * response body and never an `error_description`. A token request carries the client secret, and a
 * rejection from an API gateway can quote the request that produced it.
 */

import * as oauth from 'oauth4webapi';

/**
 * How a provider wants the client secret presented at its token endpoint.
 *
 * ### `basic` re-encodes the credential, and not every provider undoes that
 *
 * RFC 6749 Appendix B requires HTTP Basic credentials to be form-urlencoded *before* base64, with
 * the unreserved set narrowed to letters and digits — so `-`, `_`, `.` and `~` become percent
 * escapes. `oauth4webapi` does this correctly. A provider that documents Basic as plain base64 of
 * `client_id:client_secret`, and does not say it decodes, will therefore compare against a different
 * secret than the one in the dashboard whenever that secret contains one of those four characters.
 * The symptom is a 401 that reads like a wrong secret.
 *
 * Discord is exactly that case, which is why it uses `body` — it accepts either, and `body` passes
 * the credential through untouched. Prefer `body` for any provider that offers it, and reach for
 * `basic` only where a provider requires it; then check what its documentation says about encoding
 * before trusting a secret containing anything but letters and digits.
 */
export type ClientAuth = 'basic' | 'body';

/** A provider's documented departure from the specification. */
export interface Quirk {
	/**
	 * Join an array-valued `scope` in a token response into the space-delimited string the
	 * specification requires. Twitch needs this; see the note at the top.
	 */
	readonly spaceDelimitedScope?: boolean;
}

/** One provider's OAuth 2.0 configuration. */
export interface OAuth2App {
	readonly clientId: string;
	readonly clientSecret: string;

	/** Where the visitor is sent to approve. */
	readonly authorizationEndpoint: string;

	/** Where a code is exchanged. */
	readonly tokenEndpoint: string;

	/** See {@link ClientAuth}. */
	readonly clientAuth: ClientAuth;

	/** See {@link Quirk}. Absent means "behaves as specified". */
	readonly quirks?: Quirk;
}

/** What a provider's callback produced, as the flow hands it over. */
export interface Callback {
	/** The callback's query parameters, exactly as they arrived. */
	readonly params: URLSearchParams;

	/** The state from the cookie — not from the callback. See the note at the top. */
	readonly expectedState: string;

	/** The PKCE verifier, for a provider that uses one. */
	readonly verifier: string | null;

	/** The redirect that was registered, which the token request has to repeat. */
	readonly redirectUri: string;
}

/** A token pair, in this project's terms rather than the wire's. */
export interface OAuth2Tokens {
	readonly accessToken: string;

	readonly refreshToken: string | null;

	/** Unix seconds, or null for a provider that did not say. */
	readonly expiresAt: number | null;

	/** The scopes actually granted, which are not always the ones asked for. */
	readonly scopes: readonly string[];
}

/** Why a flow did not finish. Two kinds, because that is all a visitor can act on. */
export type FailureKind = 'refused' | 'unreachable';

/**
 * A flow that did not finish.
 *
 * Carries the provider's short `error` code when there was one — `invalid_grant` and such, which is
 * an enumerated value worth logging — and never its `error_description` or body.
 */
export class OAuth2Failure extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly code: string | null
	) {
		super(kind === 'refused' ? 'the provider refused the request' : 'the provider was unreachable');
		this.name = 'OAuth2Failure';
	}
}

/** A fresh `state` parameter. */
export function oauthState(): string {
	return oauth.generateRandomState();
}

/** A fresh PKCE verifier, for a provider that uses one. */
export function codeVerifier(): string {
	return oauth.generateRandomCodeVerifier();
}

/** Where to send the visitor to approve. */
export async function authorizationUrl(
	app: OAuth2App,
	options: {
		readonly state: string;
		readonly redirectUri: string;
		readonly scopes: readonly string[];
		readonly verifier?: string | null;
	}
): Promise<URL> {
	const url = new URL(app.authorizationEndpoint);

	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', app.clientId);
	url.searchParams.set('redirect_uri', options.redirectUri);
	url.searchParams.set('state', options.state);

	// Omitted entirely rather than sent empty: a provider reading `scope=` as "no scopes" and one
	// reading it as a malformed request are both in the wild, and absent is unambiguous.
	if (options.scopes.length > 0) url.searchParams.set('scope', options.scopes.join(' '));

	if (typeof options.verifier === 'string') {
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set(
			'code_challenge',
			await oauth.calculatePKCECodeChallenge(options.verifier)
		);
	}

	return url;
}

/** A code, exchanged for tokens. */
export async function exchangeCode(app: OAuth2App, callback: Callback): Promise<OAuth2Tokens> {
	const validated = validate(app, callback);

	return read(
		async () =>
			await oauth.authorizationCodeGrantRequest(
				server(app),
				client(app),
				clientAuth(app),
				validated,
				callback.redirectUri,
				// `nopkce` is deprecated to make a PKCE-less exchange conspicuous, not because it stopped
				// working, and there is no other way to express "this provider has none". A provider
				// reaches this branch only by returning a null verifier from `authorize`, which today is
				// Twitch alone: PKCE appears nowhere in Twitch's authentication documentation. Discord
				// documents it and now uses it, so it takes the other branch. Revisit per provider.
				// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
				callback.verifier ?? oauth.nopkce,
				requestOptions(app)
			),
		async (response) =>
			await oauth.processAuthorizationCodeResponse(server(app), client(app), response)
	);
}

/**
 * A refresh token, exchanged for a new pair.
 *
 * Here rather than in each provider because nothing about it is provider-specific, and because a
 * link that lapses silently is the failure mode the account page exists to make visible.
 */
export async function refreshTokens(app: OAuth2App, refreshToken: string): Promise<OAuth2Tokens> {
	return read(
		async () =>
			await oauth.refreshTokenGrantRequest(
				server(app),
				client(app),
				clientAuth(app),
				refreshToken,
				requestOptions(app)
			),
		async (response) => await oauth.processRefreshTokenResponse(server(app), client(app), response)
	);
}

/**
 * The callback parameters, as the library will accept them.
 *
 * `validateAuthResponse` is the only way to obtain them — it brands what it returns — and it is also
 * what turns `error=access_denied` into a thrown error rather than a missing code noticed later.
 */
function validate(app: OAuth2App, callback: Callback): URLSearchParams {
	try {
		return oauth.validateAuthResponse(
			server(app),
			client(app),
			callback.params,
			callback.expectedState
		);
	} catch (cause) {
		throw new OAuth2Failure(
			'refused',
			cause instanceof oauth.AuthorizationResponseError ? cause.error : null
		);
	}
}

/** One request and its processing, with both failure kinds separated. */
async function read(
	send: () => Promise<Response>,
	process: (response: Response) => Promise<oauth.TokenEndpointResponse>
): Promise<OAuth2Tokens> {
	let response;

	try {
		response = await send();
	} catch {
		// Transport only: the request never got an answer, so there is nothing to have refused it.
		throw new OAuth2Failure('unreachable', null);
	}

	try {
		return tokens(await process(response));
	} catch (cause) {
		// Never `error_description` and never the body. The request carried the client secret, and a
		// rejection can quote the request that produced it.
		throw new OAuth2Failure(
			'refused',
			cause instanceof oauth.ResponseBodyError ? cause.error : null
		);
	}
}

/** A token response, in this project's terms. */
function tokens(response: oauth.TokenEndpointResponse): OAuth2Tokens {
	const expiresIn = response.expires_in;

	return {
		accessToken: response.access_token,
		refreshToken: response.refresh_token ?? null,

		// Only when the provider said, and only when it said something usable. Twitch sends `0` for a
		// token type it does not expire, and arithmetic on that would put the expiry at the epoch and
		// make every such link render as lapsed forever.
		expiresAt:
			typeof expiresIn === 'number' && expiresIn > 0
				? Math.floor(Date.now() / 1000) + expiresIn
				: null,
		scopes: response.scope === undefined ? [] : response.scope.split(' ').filter((s) => s !== '')
	};
}

/** The authorization server, as the library describes one. */
function server(app: OAuth2App): oauth.AuthorizationServer {
	return {
		// None of these providers publish discovery metadata, and only Twitch is even an OpenID
		// provider. The issuer is unused by the authorization-code grant and is set to the token
		// endpoint's origin so it is at least not a fiction about some other host.
		issuer: new URL(app.tokenEndpoint).origin,
		authorization_endpoint: app.authorizationEndpoint,
		token_endpoint: app.tokenEndpoint
	};
}

/** The client, as the library describes one. */
function client(app: OAuth2App): oauth.Client {
	return { client_id: app.clientId };
}

/** The client authentication the provider actually wants. See the note at the top. */
function clientAuth(app: OAuth2App): oauth.ClientAuth {
	return app.clientAuth === 'basic'
		? oauth.ClientSecretBasic(app.clientSecret)
		: oauth.ClientSecretPost(app.clientSecret);
}

/** Per-provider request options, which today means the quirk shim. */
function requestOptions(app: OAuth2App): oauth.TokenEndpointRequestOptions {
	return app.quirks?.spaceDelimitedScope === true ? { [oauth.customFetch]: joinScope } : {};
}

/**
 * Twitch's array-valued `scope`, rewritten to the space-delimited string the specification requires.
 *
 * A fetch wrapper rather than a patch to the parsed result, because the refusal happens inside the
 * library's own processing — by the time a result came back there would be nothing to fix.
 *
 * Anything unexpected is passed through untouched. A response that is not JSON, or whose `scope` is
 * already a string, is not this function's business, and rewriting it would hide the real failure.
 */
async function joinScope(...args: Parameters<typeof fetch>): Promise<Response> {
	const response = await fetch(...args);
	const text = await response.clone().text();

	let body: unknown;

	try {
		body = JSON.parse(text);
	} catch {
		return response;
	}

	if (!isRecord(body) || !Array.isArray(body.scope)) return response;

	const scope = body.scope.filter((part): part is string => typeof part === 'string').join(' ');

	return new Response(JSON.stringify({ ...body, scope }), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

/** A JSON object, as far as property access is concerned. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
