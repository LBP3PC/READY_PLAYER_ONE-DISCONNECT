import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { validateStudioBuildValidationToken } from '@repo/jwt'

import charadesAprilWords from '../../static/charades-april.json'
import charadesWords from '../../static/charades.json'
import communityBoard from '../../static/community-board.json'
import { authedId, unauthorized } from '../http'
import {
	AUTHED,
	BareString,
	BulkAllowedRequest,
	BulkAllowedResponse,
	form,
	idParam,
	IsPureResponse,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	KeepsakeCategories,
	KeepsakeConfig,
	KeepsakeEventInstances,
	KeepsakeRoomInstances,
	SanitizeRequest,
	stringParam,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import {
	censorSwears,
	containsSwears,
	DEFAULT_REPLACEMENT_CHAR,
	removeBlockedCharacters,
} from '../sanitize'

import type { Context } from 'hono'
import type { App } from '../context'

/**
 * The site's own photo gallery — « Photos prises en jeu » on recblue.net, which it feeds
 * from `/api/game/photos` — mirrored into the board's Instagram strip.
 *
 * The board is otherwise a static blob (`static/community-board.json`), and its photos are
 * injected per request instead of baked in: players publish from the game, the site shows
 * them straight away, and the board follows without a redeploy. A minute of edge cache
 * keeps the subrequest off the hot path, and any failure — non-200, bad JSON, no usable
 * image keys — falls back to the static strip, because a board with slightly stale photos
 * beats one that fails to load.
 */
const SITE_PHOTOS_URL = 'https://recblue.net/api/game/photos?take=12'
/**
 * Where the photo files live. The site only lists them; and it cannot serve them —
 * `recblue.net/sharecamera/…` has never been an image route, so handing the client that
 * left every photo on the board empty. (`SITE_PHOTOS_CACHE_KEY` below is not a file URL.)
 */
const BOARD_PHOTOS_HOST = 'https://img.recblue.net'
/** Seconds the photo list is cached at the edge before the site is asked again. */
const SITE_PHOTOS_CACHE_SECONDS = 60
/** Cache entry key; a plain URL nothing else requests. */
const SITE_PHOTOS_CACHE_KEY = 'https://api.recblue.net/__cache/community-board-photos'
/** A board photo, as the client's Instagram strip reads it. */
interface BoardPhoto {
	ImageName: string
	ImageUrl: string
}

/**
 * The `img` worker key behind a site photo URL, or null when it is not one. The site serves
 * its photos with an absolute URL whose path is the `img` key — possibly under `image/`,
 * the `storage` prefix the worker strips back off — so both spellings resolve.
 */
function sitePhotoKey(url: unknown): string | null {
	if (typeof url !== 'string' || url === '') return null
	let path: string
	try {
		path = decodeURIComponent(new URL(url).pathname)
	} catch {
		return null
	}
	const key = path.replace(/^\//, '').replace(/^image\//, '')
	return key === '' || key.includes('..') ? null : key
}

/** The board's `InstagramImages` taken live from the site, or null when unavailable. */
async function siteInstagramImages(): Promise<BoardPhoto[] | null> {
	const cache = typeof caches === 'undefined' ? undefined : caches.default
	let body: string

	const cached = await cache?.match(SITE_PHOTOS_CACHE_KEY)
	if (cached) {
		body = await cached.text()
	} else {
		const response = await fetch(SITE_PHOTOS_URL, {
			headers: { accept: 'application/json' },
			// A board request must not hang on the site: give up and serve the static strip.
			signal: AbortSignal.timeout(2000),
		})
		if (!response.ok) return null
		body = await response.text()
		if (cache) {
			await cache
				.put(
					SITE_PHOTOS_CACHE_KEY,
					new Response(body, {
						headers: {
							'content-type': 'application/json',
							'cache-control': `max-age=${SITE_PHOTOS_CACHE_SECONDS}`,
						},
					})
				)
				.catch(() => undefined)
		}
	}

	const data: unknown = JSON.parse(body)
	const list = Array.isArray(data) ? data : ((data as { photos?: unknown } | null)?.photos ?? [])
	if (!Array.isArray(list)) return null

	const images: BoardPhoto[] = []
	for (const photo of list) {
		const key = sitePhotoKey((photo as { url?: unknown } | null)?.url)
		if (key) images.push({ ImageName: key, ImageUrl: BOARD_PHOTOS_HOST })
	}
	return images.length > 0 ? images : null
}

/** The static board with the site's live photos in place of its baked-in strip. */
async function communityBoardWithPhotos(): Promise<typeof communityBoard> {
	const images = await siteInstagramImages().catch(() => null)
	if (images === null) return communityBoard
	return { ...communityBoard, InstagramImages: images }
}

/**
 * A sanitize request, as the client posts it:
 *
 * ```json
 * { "Value": "...", "ReplacementChar": "*", "Context": "RoomChat",
 *   "Intent": 1, "ruleset": 0, "PreRemoveBlockedCharacters": false }
 * ```
 *
 * Fields are read case-insensitively because the client's own casing isn't consistent —
 * it sends `ruleset` lowercase among otherwise PascalCase keys, and a reader that trusts
 * one spelling silently ignores the other.
 *
 * `Context` ("RoomChat", and whatever else names the surface being checked), `Intent` and
 * `ruleset` are read but not acted on: they select among the reference's several
 * filtering policies and this server has one, so honouring them would mean inventing
 * differences between them. A body that isn't JSON, or carries no `Value`, reads as the
 * empty string — nothing to object to, rather than a bad request.
 */
async function sanitizeRequest(
	c: Context<App>
): Promise<{ value: string; replacementChar: string; preRemoveBlockedCharacters: boolean }> {
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({}) as Record<string, unknown>)
	const field = (name: string): unknown => {
		const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
		return key === undefined ? undefined : body[key]
	}
	const value = field('Value')
	const replacementChar = field('ReplacementChar')
	return {
		value: typeof value === 'string' ? value : '',
		replacementChar:
			typeof replacementChar === 'string' && replacementChar !== ''
				? replacementChar
				: DEFAULT_REPLACEMENT_CHAR,
		preRemoveBlockedCharacters: field('PreRemoveBlockedCharacters') === true,
	}
}

/**
 * The Charades word bank for a given moment: the April Fools list on April 1st, the
 * ordinary list every other day.
 *
 * A REPLACEMENT, not an addition — the joke list stands alone for the day, which is why
 * its ids (1258+) start past the end of the ordinary one rather than overlapping it. The
 * client fetches the bank when the activity starts, so a game already running keeps
 * whichever list it drew.
 *
 * The date is read in UTC, so the swap runs 00:00-23:59 UTC on April 1 for everyone
 * rather than rolling around the world with local midnight. `now` is injectable so tests
 * can pick a day.
 */
export function charadesWordsFor(now: Date = new Date()) {
	const isAprilFools = now.getUTCMonth() === 3 && now.getUTCDate() === 1
	return isAprilFools ? charadesAprilWords : charadesWords
}

// Text sanitization, keepsakes, objectives/events/rewards, and the misc analytics
// sinks the client hits during load.
export const gameplayRoutes = new Hono<App>({ strict: false })
	// Text sanitization (display names, room names, chat). `v1` masks the swears in the
	// text and hands it back; `isPure` answers the same question as a yes/no.
	.post(
		'/api/sanitize/v1',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Sanitize a string',
			description:
				'Masks any swear in the posted `Value` and returns the cleaned text as a bare JSON ' +
				'string. Each character of a swear becomes the request’s `ReplacementChar` (`*` when ' +
				'it names none), so the shape of the message survives; text with nothing to object ' +
				'to comes back untouched. `PreRemoveBlockedCharacters` strips control and zero-width ' +
				'characters first — the ones used to break a word up so a filter misses it. ' +
				'`Context`, `Intent` and `ruleset` are accepted and ignored: they pick among the ' +
				'reference’s filtering policies, and this server has one.',
			requestBody: jsonBody(SanitizeRequest, 'The text to clean'),
			responses: { 200: json(BareString, 'The cleaned text (a bare JSON string)') },
		}),
		async (c) => {
			const { value, replacementChar, preRemoveBlockedCharacters } = await sanitizeRequest(c)
			const text = preRemoveBlockedCharacters ? removeBlockedCharacters(value) : value
			return c.json(censorSwears(text, replacementChar))
		}
	)
	// The yes/no form of the filter, and the one that actually filters: the client asks
	// this before it accepts a display name, a room name or an invention title. Auth-gated,
	// as the reference is — the client only ever asks while logged in.
	.post(
		'/api/sanitize/v1/isPure',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Whether a string is clean',
			description:
				'Reports whether the posted `Value` contains a swear — the check the client runs ' +
				'against a display name, room name or invention title before it accepts one. ' +
				'Matching is word-boundary aware, so ordinary words that contain a swear ' +
				'(`analysis`, `Scunthorpe`, `class`) are pure, while leetspeak (`sh1t`, `a$$hole`) ' +
				'is not. An empty or absent `Value` is pure.',
			security: AUTHED,
			requestBody: jsonBody(SanitizeRequest, 'The text to check'),
			responses: {
				200: json(IsPureResponse, 'Whether the text is clean'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const { value } = await sanitizeRequest(c)
			return c.json({ IsPure: !containsSwears(value) })
		}
	)

	// Studio checks all component text in one request, preserving duplicates and order.
	.post(
		'/api/sanitize/v2/isAllowed/bulk',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Check Studio component text in bulk',
			description:
				'Checks repeated Values form fields using the existing profanity policy. ArePure matches the input order, including duplicate and empty strings. Accepts an account token or a dedicated Studio build-validation credential with no account identity.',
			security: AUTHED,
			requestBody: form(BulkAllowedRequest, 'Repeated Values fields'),
			responses: {
				200: json(BulkAllowedResponse, 'Ordered results in a Studio result envelope'),
				400: json(BulkAllowedResponse, 'Invalid form values'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			if (
				(await authedId(c)) === null &&
				!(await validateStudioBuildValidationToken(c.req.raw, await c.env.JWT_SECRET.get()))
			)
				return unauthorized(c)
			const body = await c.req.parseBody({ all: true }).catch(() => null)
			const field = body?.Values
			const values = field === undefined ? [] : Array.isArray(field) ? field : [field]
			if (body === null || values.some((value) => typeof value !== 'string')) {
				return c.json({ Success: false, Error: 'Values must be strings.', Value: null }, 400)
			}
			return c.json({
				Success: true,
				Error: null,
				Value: { ArePure: values.map((value) => !containsSwears(value as string)) },
			})
		}
	)

	// ---- Activities -----------------------------------------------------------
	// Word bank for the Charades activity. The client requests the list by
	// activity name (`.../words/Charades`); other activities have no data yet.
	// On April 1st (UTC) the joke list replaces it — see `charadesWordsFor`.
	.get(
		'/api/activities/charades/v1/words/:activity',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'An activity’s word bank',
			description:
				'The words the Charades activity draws from. The client asks by activity name ' +
				'(`.../words/Charades`); the name is not matched on, so every activity gets the ' +
				'charades list — no other activity has data yet. On April 1st (UTC) the April ' +
				'Fools word list is served in place of the ordinary one.',
			parameters: [stringParam('activity', 'Activity name, e.g. `Charades`. Not matched on.')],
			responses: { 200: json(JsonArray, 'The word list') },
		}),
		(c) => c.json(charadesWordsFor())
	)

	// Keepsakes (room mementos). Stubbed empty.
	.get(
		'/api/keepsakes/globalconfig',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake feature switches',
			description:
				'Whether keepsakes (room mementos) are on and how many a room may hold. Reports ' +
				'OFF because nothing stores keepsakes: announcing the feature while every read ' +
				'behind it answers empty makes the room UI build its keepsake icon list against a ' +
				'null model, which throws `NullReferenceException` every time the room panel ' +
				'refreshes (92 of 107 in one session, `RoomModel.GetUncollectedKeepsakeCountPer' +
				'CategoryForRoom` and `CompositeController.Dispose`). With the feature off the ' +
				'panel skips it; turn it back on with a real catalog, not before.',
			responses: { 200: json(KeepsakeConfig, 'The keepsake config') },
		}),
		(c) =>
			c.json({ KeepsakeFeatureEnabled: false, KeepsakeRoomLimit: 0, SocialXpBoostEnabled: false })
	)
	.get(
		'/api/keepsakes/rooms/:roomId',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'A room’s keepsakes',
			description:
				'No keepsake storage yet, so the room has no instances — but this answers a JSON ' +
				'object, never a bodiless 204: the client deserializes it into a non-null DTO and ' +
				'maps `KeepsakeInstanceIds` out of it, so an empty body left it with a null model ' +
				'and threw `NullReferenceException` on every room-panel refresh ' +
				'(`RoomModel.GetUncollectedKeepsakeCountPerCategoryForRoom`), which froze the ' +
				'watch menu’s room panel instead of merely showing no keepsakes.',
			parameters: [idParam('roomId', 'Room id')],
			responses: { 200: json(KeepsakeRoomInstances, 'The room’s keepsake instances — empty') },
		}),
		(c) =>
			c.json({
				KeepsakeRoomId: Number.parseInt(c.req.param('roomId') ?? '', 10) || 0,
				KeepsakeInstanceIds: [],
			})
	)
	// The keepsakes a progression event hands out. This path did not exist, so the client's
	// keepsake load for an event 404'd and its model stayed null — the same NRE loop as the
	// room read above, from the same refresh. Empty collections, not a 404.
	.get(
		'/api/keepsakes/events/:eventId',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'A progression event’s keepsakes',
			description:
				'No keepsake storage yet, so an event has no instances. Answers the empty object the ' +
				'client maps, rather than the 404 it used to get — which left the room panel’s ' +
				'keepsake model null and threw on every refresh.',
			parameters: [idParam('eventId', 'Progression event id')],
			responses: { 200: json(KeepsakeEventInstances, 'The event’s keepsake instances — empty') },
		}),
		(c) =>
			c.json({
				KeepsakeProgressionEventId: Number.parseInt(c.req.param('eventId') ?? '', 10) || 0,
				KeepsakeProgressionEventIds: [],
				KeepsakeInstanceIds: [],
			})
	)
	// A counted result set, NOT the bare list the stubs around it serve: the client parses
	// this one as an object and an array fails it outright — "expected:'{', actual:'[', at
	// offset:0", logged as "Failed to get keepsake categories" — which takes the keepsake
	// load down with it. `TotalResults` is the length of `Results`, not a total behind a
	// page; the reference returns `results.Length`.
	.get(
		'/api/keepsakes/categories',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Keepsake categories',
			description:
				'No keepsake catalog yet, so the result set is empty — but it IS a result set ' +
				'(`{ Results, TotalResults }`), not the empty list the stubs around it serve. ' +
				"The client parses this one as an object and fails on an array (\"expected '{', " +
				"actual '['\"), taking the keepsake load down with it. `TotalResults` counts " +
				'`Results` itself — there is no paging here.',
			responses: { 200: json(KeepsakeCategories, 'An empty result set') },
		}),
		(c) => c.json({ Results: [], TotalResults: 0 })
	)

	// ---- Objectives / events / rewards ---------------------------------------
	// Objectives live on the `econ` host (`updateobjective` / `myprogress`), which is
	// where the client calls them — they are not served here.
	.get(
		'/api/communityboard/v2/current',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'The current community board',
			description:
				'The rotating community board on the home screen — featured player, featured room ' +
				'group, announcement and image strips. Served from a static blob, except the ' +
				'`InstagramImages` strip, which is taken live from the site’s « Photos prises en jeu » ' +
				'feed (edge-cached for a minute) so photos published in game appear without a deploy.',
			responses: { 200: json(JsonObject, 'The community board') },
		}),
		async (c) => c.json(await communityBoardWithPhotos())
	)
	// Circuit chip lists — the palettes the Maker Pen's circuit board groups its chips into
	// (`/api/CircuitChipLists/Favorites`, `/api/CircuitChipLists/Recent`, and so on). The path
	// segment names the list; nothing here records which chips a player has used or favourited,
	// so every one of them is empty.
	//
	// EMPTY rather than 404 for a name this server doesn't know: the client asks for whichever
	// palettes its build has, and an unknown one is a palette this server has no opinion about
	// rather than an error — a 404 shows as a palette that failed to load, where an empty list
	// shows as one with nothing in it, which is the truth for all of them.
	.get(
		'/api/CircuitChipLists/:list',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'One circuit chip list',
			description:
				'A palette on the Maker Pen’s circuit board, named by the path (`Favorites`, ' +
				'`Recent`, …). Always empty: nothing records which chips a player has used or ' +
				'favourited yet. An unknown name is empty too rather than a 404 — the client asks ' +
				'for whichever palettes its build has, and a 404 renders as a palette that failed ' +
				'to load rather than one with nothing in it.',
			parameters: [stringParam('list', 'The palette name, e.g. `Favorites`')],
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	)

	// Player events live in their own controller (routes/events.ts) — they're D1-backed
	// now, unlike the stubs around them here.
	.get(
		'/api/announcement/v1/get',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Announcements',
			description: 'The announcement banners on the home screen. Not hydrated yet.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/announcements.json

	// GameSight attribution/analytics event sink. Accept and ack without persisting.
	.post(
		'/api/gamesight/event',
		describeRoute({
			tags: ['Gameplay'],
			summary: 'Analytics event sink',
			description:
				'The client’s GameSight attribution/analytics events. Accepted and dropped — ' +
				'nothing is persisted. Answers the `OkResponse` shape (`Success`, `Error`) the 2023 client’s ' +
				'decoder reads it as an object — a blank body fails as "Response was empty", an array as a malformed response.',
			responses: { 200: { description: 'Accepted (OkResponse)' } },
		}),
		(c) => c.json({ Success: true, Error: null })
	)
