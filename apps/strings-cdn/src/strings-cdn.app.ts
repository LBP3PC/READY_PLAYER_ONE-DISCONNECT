import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import { HealthResponse, json, StringsDocumentResponse, StringsTableResponse } from './openapi'
import { STRINGS_VERSION, TABLES } from './strings-data'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Strings CDN worker. Serves the localisation document the game client fetches on load
 * and logs against when it falls back to key names ("Failed to retrieve strings").
 *
 * Public: there is no session to check and nothing per-player in the text.
 */
const app = new Hono<App>()
	.use('*', (c, next) =>
		useWorkersLogger(c.env.NAME, {
			environment: c.env.ENVIRONMENT,
			release: c.env.SENTRY_RELEASE,
		})(c, next)
	)
	.onError(withOnError())
	.notFound(withNotFound())

	.get(
		'/',
		describeRoute({
			tags: ['Health'],
			summary: 'Service status',
			description: 'Liveness probe: the worker answers at all.',
			responses: { 200: json(HealthResponse, 'The worker is up.') },
		}),
		(c) => c.json({ service: 'strings-cdn', status: 'ok' })
	)

	// The whole document. The client's loader reads it once on boot, so a request that
	// arrives with an unexpected query is still worth answering: log it (that is how the
	// shape gets pinned down) and serve the document either way.
	.get(
		'/strings',
		describeRoute({
			tags: ['Strings'],
			summary: 'The whole localisation document',
			description: [
				'Every table the client may override, as `table → key → text`. Tables the game',
				'ships in the build are served empty here: a key with no entry falls back to the',
				'key name client-side, which is exactly what the game does with no document at all.',
			].join('\n'),
			responses: {
				200: json(StringsDocumentResponse, 'The document.'),
				404: { description: 'No text configured, so there is no document to serve.' },
			},
		}),
		(c) => {
			logRequest(c)
			// The 2023 client's boot query (`scopePrefix=client.&eTag=20230414`) gets `{}`:
			// "no overrides", which leaves it on the tables compiled into the build. Both
			// other answers stall the loading screen on "Downloading data" — measured twice
			// on a real boot: with `tables` empty (which deserialises to a null collection,
			// `ArgumentNullException: Value cannot be null`, 2026-11-11) and again with the
			// tables filled in (`EMOTES`, `LoadingScreen`, 2026-11-12). This client does not
			// read the `{ version, tables }` envelope at all; it wants scope → numeric string
			// id → text. Serve it that shape, verified on a boot, before changing this branch.
			// The cost of `{}` is one `Failed to retrieve strings` line and a repeated
			// `Player.Interaction.EMOTES` warning, which is noise, not a blocked game.
			// The client's eTag is its build tag plus a fetch stamp (`20230414@23:14:55.661`),
			// so the build has to be compared on the part before the `@`: an exact match
			// missed once the stamp appeared, and the 2023 client was then handed the
			// `{ version, tables }` envelope it cannot deserialise (`Deserialization returned
			// null` in the console, twice per boot, followed by `Failed to retrieve strings`).
			const eTagBuild = (c.req.query('eTag') ?? '').split('@')[0]
			if (
				eTagBuild === '20230414' &&
				(c.req.query('scopePrefix') === 'client.' || c.req.query('scope')?.startsWith('client.'))
			) {
				return c.json({})
			}
			// An empty document is not a document. `{"tables": {}}` deserialises to a null
			// collection on the client, whose loader then throws `ArgumentNullException:
			// Value cannot be null` on boot and leaves the loading screen stuck on
			// "Downloading data" (read off Player.log). With no text configured the honest
			// answer is 404: the client logs "Failed to retrieve strings" and keeps the
			// tables it ships in the build, which is the state it was in before this worker.
			if (Object.keys(TABLES).length === 0) {
				return c.json({ error: 'No strings configured.' }, 404)
			}
			return c.json({ version: STRINGS_VERSION, tables: TABLES })
		}
	)

	// One table, for a loader that asks per table. An unknown name is an empty map rather
	// than a 404: the client treats a miss as "no overrides", not as an error.
	.get(
		'/strings/:table',
		describeRoute({
			tags: ['Strings'],
			summary: 'One localisation table',
			description: 'The named table as `{ version, table, strings }`; unknown names are empty.',
			responses: { 200: json(StringsTableResponse, 'The table (possibly empty).') },
		}),
		(c) => {
			logRequest(c)
			const table = c.req.param('table')
			return c.json({
				version: STRINGS_VERSION,
				table,
				strings: TABLES[table] ?? {},
			})
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare strings-cdn',
					version: '1.0.0',
					description: [
						'The localisation document for recflare, a private-server reimplementation of',
						'the Rec Room backend. The client fetches it on load; keys it does not carry',
						'fall back to the game’s own English tables, then to the key name.',
					].join('\n'),
				},
				servers: [{ url: 'https://strings-cdn.recblue.net', description: 'Production' }],
			},
		})
	)
)

/**
 * Record what the client actually asked for — path, query and the two headers a CDN
 * loader varies on — so the request shape can be read off `wrangler tail` instead of
 * guessed. One line per fetch: this route is hit once per boot.
 */
function logRequest(c: Context<App>) {
	const url = new URL(c.req.url)
	console.log('strings fetch', {
		method: c.req.method,
		path: url.pathname,
		query: url.search,
		accept: c.req.header('accept') ?? '',
		acceptLanguage: c.req.header('accept-language') ?? '',
	})
}

export default app
