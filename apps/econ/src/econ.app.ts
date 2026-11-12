import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import {
	addXp,
	canManageRoomById,
	consumeGift,
	countPlayersByRoom,
	createGift,
	GAME_VERSION,
	getAccount,
	getGift,
	getOutfits,
	getPendingGifts,
	getPlayerIdsInRoom,
	getPresence,
	grantInvention,
	levelReward,
	levelsReached,
	listInfluencerIds,
	movePlayerToDorm,
	ownsInvention,
	SavedImageType,
	setOutfit,
	updateAccount,
} from '@repo/domain'
import { intVar, logger, withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetBuild, validateAndGetPlus } from '@repo/jwt'

import {
	getCustomAvatarItems,
	isQuestAssetTarget,
	toQuestCustomAvatarItem,
	toUgcPurchasable,
	UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM,
} from '../../api/src/custom-avatar-items-db'
import { getInventionById, toInventionV9, toSaveResult } from '../../api/src/inventions-db'
// The profanity filter behind `api`'s `POST /api/sanitize/v1`, imported rather than copied
// so a gift note is masked by the very same word list every other player-typed string is.
import { censorSwears } from '../../api/src/sanitize'
// The notification-type ids the hub carries, and the payload shapes recovered from the
// client's own decoder (both owned by the `notify` worker). Imported rather than copied so
// the frames this worker builds are typed by the shapes the client actually parses — a
// wrong or renamed key (see the `Platform`/`BalanceType` trap) fails the build here.
import { BalanceAddType, KickReportCategory } from '../../notify/src/notification-payloads'
import type { ModerationKickPayload } from '../../notify/src/notification-payloads'
import { NotificationType } from '../../notify/src/notification-types'
import adCarouselItems from '../static/ad-carousel-items.json'
import consumableDefinitions from '../static/consumables.json'
import defaultAvatarItems from '../static/default-avatar-items.json'
import defaultAvatar from '../static/default-avatar.json'
import defaultBaseAvatarItems from '../static/default-base-avatar-items.json'
import myProgress from '../static/my-progress.json'
import questRewards from '../static/quest-rewards.json'
import { getAvatar, setAvatar } from './avatar-db'
import {
	ALL_PLATFORMS,
	creditCurrency,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	ensureStartingBalances,
	getBalance,
	isSpendable,
	spendCurrency,
} from './balance-db'
import { getCatalogItem, getStoreListings, toCatalogAvatarItem } from './catalog-db'
// `LEGACY_CLIENT_BUILD` is shared with the storefront generator rather than restated: it picks
// which store FILE a caller is served here, and is what the generator's help names.
import {
	CatalogKind,
	LEGACY_CLIENT_BUILD,
	type StoreListing,
	type StorefrontDump,
} from './catalog-load'
import { claimChallengeGift, getChallengeStatuses, recordChallengeProgress } from './challenge-db'
import { buildRotation, rotationMapId, withWeeklyGift } from './challenge-rotation'
import {
	consumeConsumable,
	countConsumable,
	getConsumables,
	grantConsumable,
} from './consumables-db'
import { grantDiscordRoleGifts } from './discord-role-gift'
import { getEquipment, grantEquipment, setEquipmentFavorited } from './equipment-db'
import {
	getOwnedCustomAvatarItems,
	grantCustomAvatarItem,
	ownedCustomAvatarItemIds,
} from './inventory-custom-db'
import { getInventory, grantItem, legacyWardrobeItems, toAvatarItemV4 } from './inventory-db'
import {
	AUTHED,
	AvatarItemV4Dto,
	AvatarV2Dto,
	AwardRoomConsumableResultList,
	AwardRoomConsumablesRequest,
	AwardRoomCurrencyRequest,
	AwardRoomCurrencyResultList,
	AwardRoomKeyResultList,
	AwardRoomKeysRequest,
	BalanceEntry,
	BulkPurchaseRequest,
	BulkPurchaseResponse,
	BuyInventionRequest,
	BuyInventionResponse,
	BuyInventionV3Response,
	BuyItemRequest,
	BuyItemResponse,
	BuyRoomKeyResponse,
	ChallengeProgressRequest,
	ChallengeProgressResponse,
	ChecklistCompleteResponse,
	ChecklistEntry,
	CompleteChecklistRequest,
	ConsumeConsumableRequest,
	ConsumeEnvelope,
	ConsumeGiftRequest,
	ConsumeRoomConsumableRequest,
	ConsumeRoomConsumableResponse,
	CreatePurchaseOfferRequest,
	CreateRoomCurrencyRequest,
	CreateRoomKeyRequest,
	CustomAvatarItemsResponse,
	DeletePurchaseOfferRequest,
	EquipmentUpdateRequest,
	ErrorResponse,
	form,
	GameRewardRequest,
	GrantRoomBadgeRequest,
	GrantRoomBadgeResponse,
	HeldRoomKeyDto,
	InfluencerIdsResponse,
	IsOnWishlistBulkRequest,
	IsOnWishlistBulkResponse,
	ItemPurchaseInfoList,
	ItemPurchaseInfosRequest,
	json,
	JsonArray,
	jsonBody,
	JsonObject,
	LockedItemsBulkRequest,
	MakerAiFreeTrialEligibilityResponse,
	OpaqueJsonBody,
	OPTIONAL_AUTHED,
	OwnsRoomKeysRequest,
	OwnsRoomKeysResponse,
	PurchasableItemsRequest,
	PurchaseRoomConsumableRequest,
	PurchaseRoomConsumableResponse,
	PurchaseRoomCurrencyEnvelope,
	PurchaseRoomCurrencyRequest,
	PurchaseRoomKeyWithCurrencyRequest,
	PurchaseRoomKeyWithCurrencyResponse,
	QueryConsumablesRequest,
	ReferralProgressResponse,
	RemoveInfluencerBody,
	RoomConsumableDto,
	RoomConsumableEnvelope,
	RoomConsumableInventoryItemDto,
	RoomCurrencyBalance,
	RoomCurrencyDto,
	RoomCurrencyEnvelope,
	RoomCurrencyPurchaseOfferDto,
	RoomCurrencyPurchaseOfferEnvelope,
	RoomCurrencyPurchaseOffersDto,
	RoomEconConfig,
	RoomKeyDto,
	RoomKeyEnvelope,
	RoomPurchasableList,
	RRPlusSignUpBonus,
	SaveOutfitRequest,
	SaveOutfitV4Response,
	SubscriptionResponse,
	SupportedInfluencerResponse,
	SupportInfluencerBody,
	SupportInfluencerResponse,
	UgcPurchasableBulkRequest,
	UgcPurchasableItemList,
	UNAUTHORIZED_RESPONSE,
	UpdateActiveConsumableRequest,
	UpdateObjectiveRequest,
	UpdateObjectiveResponse,
	UpdateRoomCurrencyRequest,
	UpdateRoomKeyRequest,
	UpsertRoomConsumableRequest,
	WishlistEnvelope,
	WishlistItemList,
	WishlistItemRequest,
} from './openapi'
import { claimAllowance, claimReward, DAILY_REWARD_COOLDOWN_MS } from './reward-db'
import {
	awardRoomConsumable,
	consumeRoomConsumable,
	getRoomConsumable,
	getRoomConsumables,
	getRoomInventory,
	toInventoryItem,
	upsertRoomConsumable,
} from './room-consumable-db'
import {
	awardRoomCurrency,
	createPurchaseOffer,
	createRoomCurrency,
	deletePurchaseOffer,
	findPurchaseOffer,
	getPurchaseOffers,
	getRoomBalance,
	getRoomCurrencies,
	getRoomCurrency,
	spendRoomCurrency,
	updateRoomCurrency,
} from './room-currency-db'
import {
	awardRoomKey,
	claimRoomKey,
	createRoomKey,
	getHeldRoomKeys,
	getRoomKey,
	getRoomKeys,
	getRoomOwnerId,
	ownsRoomKeys,
	releaseRoomKey,
	updateRoomKey,
} from './room-key-db'
import { getRoomPurchasables } from './room-purchasables-db'
import { halloweenCatalog, halloweenIsLive } from './halloween-shop'
import { dailyStorefront } from './daily-storefront'
import { basePriceListings, basePriceStorefront } from './storefront-pricing'
import {
	addWishlistItem,
	getWishlist,
	isOnWishlists,
	parseWishlistTarget,
	removeWishlistItem,
} from './wishlist-db'

import type { Context } from 'hono'
import type { GiftContent, Outfit, Progression, StoredGift, XpGrant } from '@repo/domain'
import type { CustomAvatarItem } from '../../api/src/custom-avatar-items-db'
import type { SavedInvention } from '../../api/src/inventions-db'
import type {
	BalanceResponsePayload,
	ConsumableMappingPayload,
	LocalRoomKeyPayload,
	PurchaseBalanceModificationPayload,
	RoomCurrencyPayload,
} from '../../notify/src/notification-payloads'
import type { Avatar } from './avatar-db'
import type { CatalogRow } from './catalog-db'
import type {
	ChallengeGiftBlock,
	EquipmentGift,
	WeeklyChallengeRotation,
} from './challenge-rotation'
import type { ConsumeResult } from './consumables-db'
import type { App, Env } from './context'
import type { Equipment } from './equipment-db'
import type { AvatarItem } from './inventory-db'
import type { RoomConsumable, RoomConsumableInventoryItem } from './room-consumable-db'
import type { RoomCurrency, RoomCurrencyPurchaseOffer } from './room-currency-db'
import type { RoomKey, RoomKeyHolding } from './room-key-db'
import type { WishlistItem } from './wishlist-db'

// Invention storage (owned by the `api` worker, on this same `recflare` database).
// Imported directly rather than copied: these are plain D1 helpers with no bindings of
// their own, and buyInvention has to read the very rows `api` writes.
// Custom avatar items likewise live in an `api`-owned table; the UGC-purchasable bulk
// lookup is the store's view of those rows.

/**
 * Economy Worker. Hosts the avatar/economy endpoints the game client calls on
 * the `econ` service (these are separate from the main `api` worker). Balances,
 * inventory (avatar items, equipment, bought inventions), consumables, saved outfits,
 * avatars, gift boxes, weekly-challenge progress and game-reward eligibility are D1-backed;
 * storefront catalogs are static assets (`sf{N}.json`) served via the ASSETS
 * binding. Some routes are still empty-list stubs (equipment, room consumables, …).
 *
 * Auth-gated routes validate the Bearer JWT issued by the `auth` worker.
 */

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is
 * missing, the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/**
 * The client build this request's token was minted for (`rn.ver`), as a comparable NUMBER —
 * the leading `YYYYMMDD` of e.g. `20250718.01`, whose `.01` is a same-day rebuild and not a
 * version to order by (`validateAndGetBuild` drops it). `null` when there is no valid
 * token, when it carries no `rn.ver` (an older token, issued before the claim did), or
 * when the claim isn't a build at all.
 *
 * Unverified — a client can claim any build — which is fine for what it gates here: a build
 * lying about itself only changes which storefront its own player is shown.
 */
async function authedBuild(c: Context<App>): Promise<number | null> {
	const version = await validateAndGetBuild(c.req.raw, await c.env.JWT_SECRET.get())
	if (version === null) return null
	const build = Number.parseInt(version, 10)
	return Number.isInteger(build) ? build : null
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/** The badge tab reads another account's inventory, filtered before paging. */
async function customAvatarItemsPage(c: Context<App>, accountId: number, callerId: number) {
	const owned = await getOwnedCustomAvatarItems(c.env.DB, accountId)
	const outfitType = c.req.query('outfitType')
	const visible = owned.filter(
		(item) =>
			(accountId === callerId || item.Accessibility !== 0) &&
			(outfitType === undefined || item.OutfitType === Number(outfitType))
	)
	const pageNumber = (value: string | undefined, fallback: number) => {
		const parsed = Number(value ?? fallback)
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
	}
	const skip = pageNumber(c.req.query('skip'), 0)
	const take = Math.min(pageNumber(c.req.query('take'), 1000), 1000)
	const page = visible.slice(skip, skip + take)
	const Results = isQuestAssetTarget(c.req.query('unityAssetTarget'))
		? page.map(toQuestCustomAvatarItem)
		: page
	return c.json({ Results, TotalResults: visible.length })
}

/**
 * The `Error` a wishlist write answers when its body names no item. Shown to the player
 * verbatim behind the client's “Wishlist error: ” prefix, so it is a sentence, not a code.
 */
const WISHLIST_NO_ITEM = 'No item was specified.'

/**
 * The `{ Value, Success, Error, error_id }` envelope the wishlist writes answer in — the
 * same shape the room-currency writes use. A null `item` with no `error` is still a success
 * (removing something that wasn't listed); an `error` makes it a refusal.
 */
function wishlistEnvelope(c: Context<App>, item: WishlistItem | null, error?: string) {
	return c.json({
		Value: item,
		Success: error === undefined,
		Error: error ?? null,
		error_id: null,
	})
}

/**
 * The item a wishlist write's form body names — `purchasableItemId` or `customAvatarItemId`,
 * as the client spells them, with the PascalCase spellings accepted for a hand-written
 * request. Null when the body names nothing usable (see `parseWishlistTarget`).
 */
async function wishlistTargetFromBody(c: Context<App>) {
	const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
	return parseWishlistTarget(
		body.purchasableItemId ?? body.PurchasableItemId,
		body.customAvatarItemId ?? body.CustomAvatarItemId
	)
}

/**
 * A boolean the client may send either as a JSON `true` or as .NET's `bool.ToString()`
 * output — `"True"`/`"False"`, capitalized. `Boolean(value)` is a trap here: the string
 * `"False"` is truthy, so a client reporting "not complete" would read as complete.
 * Anything unrecognised (missing, `null`, `""`) is false.
 */
function parseBool(value: string | boolean | undefined): boolean {
	return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true'
}

/**
 * Shared parse/validate/store for the save-outfit routes (v3 and v4). Persists the
 * posted outfit into its `Slot` verbatim and returns the stored `Outfit`; on the
 * unauth or bad-body path it returns the Response to send directly (401, or 400 for a
 * non-object body or missing/non-integer `Slot`). Callers format the success body — v3
 * echoes the whole outfit, v4 answers a lean `{ Success, Slot }` ack.
 */
async function persistPostedOutfit(c: Context<App>): Promise<Outfit | Response> {
	const id = await authedId(c)
	if (id === null) return unauthorized(c)
	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.body(null, 400)
	}
	if (!Number.isInteger(body.Slot)) return c.body(null, 400)
	const outfit = body as Outfit
	await setOutfit(c.env.DB, id, outfit)
	return outfit
}

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/**
 * The messages the room-currency failure paths carry. One string per endpoint, not per
 * reason: the client unwraps the envelope and hands its callers `Value`, so a more specific
 * message would reach nobody but a log.
 *
 * The create string is the reference's own. The update one is its obvious counterpart and has
 * not been seen on the wire — if the real client ever shows it and the wording is wrong, this
 * is the line to fix.
 */
const CREATE_CURRENCY_FAILED = 'Failed to create currency'
const UPDATE_CURRENCY_FAILED = 'Failed to update currency'
const CREATE_OFFER_FAILED = 'Failed to create purchase offer'
const DELETE_OFFER_FAILED = 'Failed to delete purchase offer'
const SAVE_CONSUMABLE_FAILED = 'Failed to save consumable'
/**
 * `Status` on the room-key create's `{ Status, RoomKey }` reply. 0 is the observed success
 * code; the refusal code has not been observed, so 1 is an assumption.
 */
const ROOM_KEY_STATUS_OK = 0
const ROOM_KEY_STATUS_FAILED = 1

/**
 * The most keys one room may list — the `RoomKeyConfig.MaxKeysPerRoom` the `api` worker's
 * config (`apps/api/static/api-config-v2.json`) tells the client, restated here so the server
 * refuses what the client already knows not to ask for.
 */
const MAX_KEYS_PER_ROOM = 10

/**
 * The most a room key may cost, by what it is priced in: tokens (a null `PurchaseCurrencyId`)
 * are real money to the player paying, so they are capped low; a room's own currency is the
 * room's to inflate.
 */
const MAX_KEY_PRICE_TOKENS = 1000
const MAX_KEY_PRICE_ROOM_CURRENCY = 1_000_000_000

/**
 * The envelope the create endpoint answers in: `{ Value, Success, Error, error_id }`.
 *
 * PascalCase beside a lowercase `error_id` — the client's own mixed casing, not a typo, and
 * NOT the lowercase `{ success, error, value }` the `rooms` worker's room mutations use.
 * A failure answers 200 with `Success: false` and a null `Value`, the way the reference's
 * failure path does; only the auth gates answer with a status of their own.
 */
function roomCurrencyEnvelope(c: Context<App>, value: RoomCurrency | null, error?: string) {
	return c.json({
		Value: value,
		Success: error === undefined,
		Error: error ?? null,
		error_id: null,
	})
}

/**
 * The room-key create's envelope: `{ Status, RoomKey }`, as the live client was observed
 * reading it — NOT the `{ Value, Success, Error, error_id }` the room-currency and consumable
 * writes beside it answer in. `Status` 0 carries the key; a refusal is a non-zero `Status`
 * with a null `RoomKey` (the refusal code is an assumption — only success has been observed).
 */
function roomKeyEnvelope(c: Context<App>, key: RoomKey | null) {
	return c.json({
		Status: key === null ? ROOM_KEY_STATUS_FAILED : ROOM_KEY_STATUS_OK,
		RoomKey: key,
	})
}

/**
 * The consumable write's envelope — the same `{ Value, Success, Error, error_id }` shape the
 * room-currency writes answer in, carrying one listing.
 */
function roomConsumableEnvelope(c: Context<App>, value: RoomConsumable | null, error?: string) {
	return c.json({
		Value: value,
		Success: error === undefined,
		Error: error ?? null,
		error_id: null,
	})
}

/**
 * The create- and delete-offer envelope — the same `{ Value, Success, Error, error_id }`
 * shape again, carrying one purchase offer.
 */
function purchaseOfferEnvelope(
	c: Context<App>,
	value: RoomCurrencyPurchaseOffer | null,
	error?: string
) {
	return c.json({
		Value: value,
		Success: error === undefined,
		Error: error ?? null,
		error_id: null,
	})
}

/**
 * Push `RoomCurrencyCreated` or `RoomCurrencyModified` for a room currency to everyone
 * standing in the room, plus whoever made the change.
 *
 * Room-wide because a room currency is room-wide: every client in there prices the room's
 * shops in it and shows what the player holds of it, so all of them need the change, not just
 * the owner who made it. An EDIT matters to them just as much as a creation — a renamed or
 * re-capped currency that only the editor hears about leaves everyone else spending the old
 * one. Read from live presence across the room's instances. The editor is added separately:
 * the settings UI opens from outside the room, and their own client is the one certain to be
 * showing the currency list right now.
 *
 * The frame is typed as the hub's {@link RoomCurrencyPayload} — the client's own model — so a
 * renamed key fails the build here rather than vanishing on the wire. It is the stored record
 * verbatim: the two are the same object, which is why the HTTP response and this frame cannot
 * drift apart.
 *
 * Best-effort, like the other pushes here — the currency has already committed, so a hub
 * hiccup must not fail the request. One unreachable player doesn't cost the rest theirs.
 */
async function pushRoomCurrencyChange(
	c: Context<App>,
	currency: RoomCurrency,
	changedByAccountId: number,
	notificationType:
		typeof NotificationType.RoomCurrencyCreated | typeof NotificationType.RoomCurrencyModified
): Promise<void> {
	const frame: RoomCurrencyPayload = currency

	// Presence is another worker's table, and this whole push is best-effort: a currency that
	// has already committed must not fail the request because the audience couldn't be read.
	// The editor still hears about it either way.
	let occupants: number[] = []
	try {
		occupants = await getPlayerIdsInRoom(c.env.DB, currency.RoomId)
	} catch (err) {
		logger.error('failed to read room presence for a room-currency push', {
			notificationType,
			roomId: currency.RoomId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	const playerIds = new Set(occupants)
	playerIds.add(changedByAccountId)

	await Promise.all(
		[...playerIds].map(async (playerId) => {
			try {
				await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
					playerId,
					notificationType,
					// Spread because `notifyPlayer` takes an index-signature record, which an
					// interface doesn't satisfy implicitly.
					{ ...frame }
				)
			} catch (err) {
				logger.error('failed to push a room-currency notification', {
					notificationType,
					playerId,
					roomId: currency.RoomId,
					currencyId: currency.CurrencyId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		})
	)
}

/**
 * Push `LocalRoomKeyCreated` (120) for a new room key to everyone standing in the room, plus
 * whoever listed it — the same audience, for the same reason, as a room currency's push: a
 * key is something every client in the room may offer for sale, and the settings UI that
 * lists one opens from outside the room, so its author is added separately.
 *
 * The frame is typed as the hub's {@link LocalRoomKeyPayload} — the client's own decoder —
 * and is the stored record verbatim, so the HTTP response and the frame cannot drift apart.
 * Best-effort: the key has already committed, and a hub hiccup must not fail the request.
 */
async function pushRoomKeyCreated(
	c: Context<App>,
	key: RoomKey,
	createdByAccountId: number
): Promise<void> {
	const frame: LocalRoomKeyPayload = key

	let occupants: number[] = []
	try {
		occupants = await getPlayerIdsInRoom(c.env.DB, key.RoomId)
	} catch (err) {
		logger.error('failed to read room presence for a room-key push', {
			roomId: key.RoomId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	const playerIds = new Set(occupants)
	playerIds.add(createdByAccountId)

	await Promise.all(
		[...playerIds].map(async (playerId) => {
			try {
				await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
					playerId,
					NotificationType.LocalRoomKeyCreated,
					{ ...frame }
				)
			} catch (err) {
				logger.error('failed to push a room-key notification', {
					playerId,
					roomId: key.RoomId,
					roomKeyId: key.RoomKeyId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		})
	)
}

/**
 * Whether a consumable is a first-party (Rec Room Original) item, as its definition in
 * `static/consumables.json` says — the value every consumable instance we serve must carry.
 *
 * The 2026 client keys an instance on this flag and checks it against the definition it holds:
 * a mismatch throws (`Key IsRRO=False does not match Definition IsRRO=True!`) and the frame is
 * lost, so the purchase never shows. Every definition in the file says true; a desc with none
 * is still a built-in store item, so it defaults to true too.
 */
const RRO_BY_DESC = new Map(
	(consumableDefinitions as Array<{ ConsumableItemDesc: string; IsRRO?: boolean }>).map((d) => [
		d.ConsumableItemDesc,
		d.IsRRO !== false,
	])
)
const isRroConsumable = (consumableItemDesc: string): boolean =>
	RRO_BY_DESC.get(consumableItemDesc) ?? true

/**
 * Push a ConsumableMappingRemoved notification to a player after they consume a
 * consumable, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(ConsumableMappingRemoved, {...}))` — the
 * client uses it to update/remove the item from inventory. Best-effort: a hub failure
 * is logged and swallowed, since the consume has already committed.
 */
async function pushConsumableRemoved(
	c: Context<App>,
	accountId: number,
	consumed: ConsumeResult
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.ConsumableMappingRemoved,
			{
				Id: consumed.id,
				ConsumableItemDesc: consumed.consumableItemDesc,
				CreatedAt: consumed.createdAt,
				Count: consumed.remaining,
				InitialCount: consumed.previousCount,
				IsActive: false,
				ActiveDurationMinutes: 0,
				IsTransferable: false,
				ActivatedByRoomie: false,
				IsRRO: isRroConsumable(consumed.consumableItemDesc),
			} satisfies ConsumableMappingPayload
		)
	} catch (err) {
		logger.error('failed to push ConsumableMappingRemoved notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a ConsumableMappingAdded notification to a player after they open a gift box
 * that carried a consumable, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(ConsumableMappingAdded, {...}))` — the client
 * uses it to show the newly-unlocked consumable. The mapping id and pre-existing count
 * were stamped onto the box at purchase (see toGiftContent). Best-effort like the
 * removed push.
 */
async function pushConsumableAdded(
	c: Context<App>,
	accountId: number,
	gift: StoredGift
): Promise<void> {
	await pushConsumableMappingAdded(c, accountId, {
		mappingId: gift.ConsumableMappingId ?? 0,
		consumableItemDesc: gift.ConsumableItemDesc,
		count: gift.ConsumableCount,
		preExistingCount: gift.ConsumablePreExistingCount ?? 0,
	})
}

/**
 * The `ConsumableMappingAdded` frame itself — one granted consumable instance (its row id,
 * how many it holds, and the player's count before it). Sent when a box carrying it is
 * opened ({@link pushConsumableAdded}) or, when there IS no box, at grant time: a purchase
 * under `BypassGiftPackages` is never opened, and without this the consumable didn't show
 * until the client refetched its inventory. Never both for one grant — a second frame for
 * the same row id could be counted twice. Best-effort like the removed push.
 */
async function pushConsumableMappingAdded(
	c: Context<App>,
	accountId: number,
	granted: {
		mappingId: number
		consumableItemDesc: string
		count: number
		preExistingCount: number
	}
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.ConsumableMappingAdded,
			{
				Id: granted.mappingId,
				ConsumableItemDesc: granted.consumableItemDesc,
				CreatedAt: new Date().toISOString(),
				Count: granted.count,
				InitialCount: granted.preExistingCount,
				IsActive: false,
				ActiveDurationMinutes: 0,
				IsTransferable: false,
				ActivatedByRoomie: false,
				IsRRO: isRroConsumable(granted.consumableItemDesc),
			} satisfies ConsumableMappingPayload
		)
	} catch (err) {
		logger.error('failed to push ConsumableMappingAdded notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * THE BALANCE-FRAME RULE, which both balance bugs came from getting wrong.
 *
 * The client holds a balance PER `(CurrencyType, Platform)` bucket and shows the SUM of the
 * buckets. Every `StorefrontBalance*` frame is an absolute SET of the one bucket it names —
 * not a change to apply — so:
 *
 *  1. `Balance` is the RESULTING TOTAL. Sending the change sets the bucket TO that change.
 *  2. The bucket key on the wire is `Platform`. The client's property is called
 *     `BalanceType` but carries a `[DataMember]` rename, and its decoder drops unknown
 *     members in silence — so a frame that says `BalanceType` lands in `Platform` 0,
 *     `SteamPurchased`, and creates a SECOND bucket that is added to the real one forever.
 *  3. That bucket must be the same one `GET /api/storefronts/v4/balance/:type` reports,
 *     `ALL_PLATFORMS`. One account-wide bucket per currency is the whole model here; a
 *     frame naming any other Platform is a phantom balance, not a per-store nicety.
 *
 * Both live bugs were rule 2 or 3, and both looked like the frame being "additive":
 *  - A player who earned 250 on 10,000 read 20,250 — `BalanceType: -2` was dropped, so the
 *    total landed in a phantom Steam bucket beside the real one.
 *  - A player who spent 900 of 17,500 read 34,100, then 33,200 once the purchase response's
 *    -900 reached the real bucket — same phantom bucket, this time from `Platform: RecNet`.
 * Neither was additivity: the totals were right, the bucket was wrong. Frames as specified
 * here are idempotent, so re-sending one or racing a `GET /balance` cannot drift the total.
 *
 * See apps/notify/src/notification-payloads.ts for the payload shapes this is recovered
 * from — the interfaces there type these calls, so a wrong key is now a build error.
 */

/**
 * Push a StorefrontBalanceUpdate (61) — "your balance in this bucket is now X" — after a
 * player's balance changes for a reason that is not their own purchase. `balance` is their
 * resulting TOTAL in that currency, per the rule above.
 *
 * A player who is reading the HTTP response for the same change gets this too: it sets the
 * bucket to the same total the body reports, so the two agree rather than compound. Pushing
 * it is what saves them a `GET /balance` re-fetch.
 *
 * Best-effort: a hub failure is logged and swallowed, since the change has already committed.
 */
async function pushBalanceUpdate(
	c: Context<App>,
	accountId: number,
	currencyType: number,
	balance: number
): Promise<void> {
	// `satisfies` rather than a type annotation: the hub takes a Record<string, unknown>, and
	// an interface (unlike an inferred object type) has no implicit index signature to match
	// it. This still checks every key against the shape the client's decoder parses.
	const payload = {
		Balance: balance,
		CurrencyType: currencyType,
		Platform: ALL_PLATFORMS,
	} satisfies BalanceResponsePayload
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.StorefrontBalanceUpdate,
			payload
		)
	} catch (err) {
		logger.error('failed to push StorefrontBalanceUpdate notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a StorefrontBalancePurchase (62) — the frame the reference sends when the balance
 * moved because the player BOUGHT something, as opposed to the plain update above. Same
 * absolute-set semantics: `balance` is the resulting total.
 *
 * `Delta` (the negated price) and `BalanceAddType` are display/telemetry only — the client
 * logs them and then stores `Balance` outright, so a correct `Delta` beside a stale
 * `Balance` still leaves the player's balance wrong. `Platform` is `ALL_PLATFORMS`, NOT
 * `RecNetPurchased`: it has to name the bucket `GET /balance` reports, and sending RecNet
 * here is exactly what doubled a buyer's tokens on screen. Best-effort, as above.
 */
async function pushBalancePurchase(
	c: Context<App>,
	accountId: number,
	currencyType: number,
	delta: number,
	balance: number
): Promise<void> {
	const payload = {
		BalanceAddType: BalanceAddType.CommercePurchase,
		Delta: delta,
		Balance: balance,
		Platform: ALL_PLATFORMS,
		CurrencyType: currencyType,
	} satisfies PurchaseBalanceModificationPayload
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.StorefrontBalancePurchase,
			payload
		)
	} catch (err) {
		logger.error('failed to push StorefrontBalancePurchase notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The influencer an account supports in the partner program, as its reads serve it — the
 * `supportedInfluencerId` on the account, or 0 for nobody (and for an account that does not
 * exist, which supports nobody too). The whole body of `/api/influencerpartnerprogram/influencer`,
 * `…/myinfluencer`, served as a bare number rather than wrapped in anything; the `…/support`
 * and `…/remove` writes answer a status envelope instead. The stored id is served as-is: it was an influencer when picked, and a later
 * revoke of their flag drops them from `…/influencers` but not from their supporters.
 */
async function supportedInfluencer(db: D1Database, accountId: number): Promise<number> {
	const account = await getAccount(db, accountId)
	return account?.supportedInfluencerId ?? 0
}

/**
 * Whether the caller holds a Rec Room Plus subscription — the ONE definition, shared by
 * `UpdateAndGetSubscription` (which reports it) and the storefront buys (which price off
 * it via `SubscriberPrices`). Those two must never disagree: a subscriber whose client
 * applied the discount itself and then had the buy refused as a price mismatch is exactly
 * what one definition prevents.
 *
 * Nothing SELLS subscriptions here. Plus is `account.hasPlus`, granted from the website
 * (`www` `POST /api/game/plus`), and it reaches this worker twice: as the token's `rn.plus`
 * claim (stamped by `auth` at login) and as the live `plusUntil` of the account row.
 *
 * The claim is the fast path; the row is what makes a fresh grant apply IMMEDIATELY. Relying
 * on the claim alone meant a player had to sign in again — and restart the game — before
 * Plus appeared, while credits were already live. So a token without the claim now falls
 * back to the account, and the client's repeated `UpdateAndGetSubscription` calls pick the
 * subscription up mid-session.
 *
 * The `developer` role does NOT grant Plus. It used to, as a stand-in while nothing else
 * could confer it; now that the Discord claim exists, Plus is one thing with one source.
 * An operator who wants a developer to have it sets `hasPlus` on their account like
 * anyone else's.
 *
 * Never read from the body. No token, or an invalid one, is "not subscribed".
 */
async function isSubscriber(c: Context<App>): Promise<boolean> {
	if (await validateAndGetPlus(c.req.raw, await c.env.JWT_SECRET.get())) return true
	// Le Plus peut être accordé depuis le site à tout moment : un jeton sans le claim n'est
	// donc plus une réponse définitive, on relit le compte pour qu'il s'applique sans
	// reconnexion (le client redemande son abonnement plusieurs fois par session).
	const id = await authedId(c)
	if (id === null) return false
	const { readAccountFlags } = await import('./site-flags')
	const flags = await readAccountFlags(c.env.DB, id)
	return flags.plusUntil !== null && Date.parse(flags.plusUntil) > Date.now()
}

/** `SubscriptionLevel.Gold`. 1 is Platinum. */
const SUBSCRIPTION_LEVEL_GOLD = 0

/** `SubscriptionPeriod.Year`. 0 is Month, 2 ThreeMonth, 3 SixMonth. */
const SUBSCRIPTION_PERIOD_YEAR = 1

/**
 * `PlatformType.All` (-1) — the subscription belongs to no single store, which is the honest
 * answer when no store sold it. The rest of the enum: 0 Steam, 1 Oculus, 2 PlayStation,
 * 3 Xbox, 4 RecNet, 5 IOS, 6 GooglePlay, 7 Standalone, 8 Pico.
 */
const SUBSCRIPTION_PLATFORM_ALL = -1

/** The id every reported subscription carries — a placeholder, since none is stored. */
const STUB_SUBSCRIPTION_ID = 1

/**
 * The complimentary subscription a subscriber reports — Rec Room Plus, which the client's
 * API calls a `CampusCard`. See `isSubscriber` for who counts as one: a `developer`, or a
 * player who claimed `hasPlus` with a Discord role on the website.
 *
 * Nothing here sells subscriptions, so holding one of those IS the subscription. Every
 * field is computed per call and none of it is persisted, so this is not a record of
 * anything — dropping the role or the flag drops the subscription, and no expiry sweep or
 * renewal exists.
 *
 * `ExpirationDate` is a year out from THIS call rather than a fixed date: a hard-coded one
 * lapses on a day nobody is expecting, and the client would start showing an expired
 * subscription with no way to renew it. `IsAutoRenewing` tells the client the same thing.
 * The dates are milliseconds-precision ISO like the rest of this worker's timestamps.
 */
function plusSubscription(accountId: number, until: string | null = null) {
	const now = new Date()
	// La date vient du SITE quand il en a une : recblue.net vend REC BLUE Plus avec sa date
	// de fin, et la page d'abonnement du jeu doit afficher CETTE date. Sans date connue, on
	// retombe sur « dans un an » (arithmétique calendaire : pas d'expiration surprise).
	const expires =
		until !== null && !Number.isNaN(Date.parse(until))
			? new Date(until)
			: (() => {
					const d = new Date(now)
					d.setUTCFullYear(d.getUTCFullYear() + 1)
					return d
				})()
	return {
		SubscriptionId: STUB_SUBSCRIPTION_ID,
		RecNetPlayerId: accountId,
		PlatformType: SUBSCRIPTION_PLATFORM_ALL,
		PlatformId: '',
		PlatformPurchaseId: '',
		Level: SUBSCRIPTION_LEVEL_GOLD,
		Period: SUBSCRIPTION_PERIOD_YEAR,
		ExpirationDate: expires.toISOString(),
		IsAutoRenewing: true,
		CreatedAt: now.toISOString(),
		ModifiedAt: now.toISOString(),
	}
}

/**
 * Project a stored avatar into the public render subset returned by
 * `GET /api/avatar/v2/:id` — the fields needed to draw another player's avatar
 * (the full blob also holds `OutfitSelectionsV2`/`CustomAvatarItems`, which this
 * view omits).
 */
function toAvatarV2Dto(avatar: Avatar) {
	return {
		OutfitSelections: avatar.OutfitSelections,
		FaceFeatures: avatar.FaceFeatures,
		SkinColor: avatar.SkinColor,
		HairColor: avatar.HairColor,
	}
}

/**
 * A storefront catalog entry's `GiftDrop` (`static/storefronts/sf{N}.json`) — what a store
 * item hands over. Field-for-field the client's own `GiftDrop` class, in its declared
 * order, so a name here is a name the client reads.
 *
 * REQUIRED vs OPTIONAL is about what this server produces, not what the client declares:
 * the required eleven are the ones every drop-building helper here sets (a game reward, a
 * level-up box, a challenge gift — see {@link toGameRewardDrop} and friends), and they are
 * the only ones the purchase and roll paths read. The rest are optional because nothing
 * here synthesizes one, whether or not a captured catalog carries it — `GiftDropId`,
 * `Unique`, `SubscribersOnly`, `ItemSetId` and `ItemSetFriendlyName` are on all 5,875
 * captured entries, while `TagList`, `CustomAvatarItemId`, `AvatarItemId`,
 * `EquipmentItemId` and `ThumbnailImageName` are on none of them.
 *
 * The store item around it carries `Prices` per currency and optionally `SubscriberPrices`
 * — the discounted list a Rec Room Plus subscriber is shown and pays. Both hold more
 * fields (IsFeatured, …) the purchase path doesn't need.
 */
interface StoreGiftDrop {
	/**
	 * The drop's own id. Every captured entry has it equal to the item's
	 * `PurchasableItemId`, which is why the paths that need one (a weekly gift, a skin)
	 * take it off there instead of from here.
	 */
	GiftDropId?: number
	FriendlyName: string
	/**
	 * NULL on 23 captured entries — the client's field is a plain string, but the catalogs
	 * keep null and `""` apart, so a reader passing it on has to collapse it (`?? ''`).
	 */
	Tooltip: string | null
	/** Not on any captured entry; nothing here reads or sets one. */
	TagList?: string
	ConsumableItemDesc: string
	AvatarItemDesc: string
	/** A UGC item's guid. Not on any captured entry — the captures predate them. */
	CustomAvatarItemId?: string | null
	AvatarItemType: number | null
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	/**
	 * A QUERY drop — a loot box rather than an item. Its item fields are all empty on
	 * purpose: what the player gets is rolled at grant time from everything of the target
	 * rarity they don't already own (see {@link rollQueryDrop}). sf2's "Star Boxes" set and
	 * sf3's "Random box" family are the two that ship; sf2's tooltip says it outright — "A
	 * random 4-star item that you don't have."
	 */
	IsQuery?: boolean
	/** Whether the player may hold only one. Nothing here enforces it. */
	Unique?: boolean
	/** Whether only a Rec Room Plus subscriber may buy it. Nothing here enforces it. */
	SubscribersOnly?: boolean
	Rarity: number
	CurrencyType: number
	Currency: number
	Context: number
	/** The set the item belongs to; null on 92 captured entries. */
	ItemSetId?: number | null
	ItemSetFriendlyName?: string
	/** Catalog ids for the item the drop carries. Not on any captured entry. */
	AvatarItemId?: number | null
	EquipmentItemId?: number | null
	/** Not on any captured entry; the client falls back to the item's own thumbnail. */
	ThumbnailImageName?: string

	// ---- Not part of the client's class -------------------------------------

	/**
	 * The rarity a query drop rolls at, when it differs from the box's own `Rarity`. The
	 * sf2 boxes carry both and they agree; sf3's don't carry it at all, hence the fallback
	 * to `Rarity`. The client's `GiftDrop` has no such field — it is the catalog's, and
	 * only this server reads it.
	 */
	QueryRedirectRarity?: number
	/**
	 * XP the drop pays out. Ours, not the client's and not any catalog's — a bought item is
	 * an item, but a game reward is XP in a gift box, so the box and its notification carry
	 * the amount from here. The XP itself is banked in `progression`, not read back off the
	 * box.
	 */
	Xp?: number
}
interface StorePrice {
	CurrencyType: number
	Price: number
	/**
	 * La remise que le catalogue porte sur ce prix. Le CLIENT l'applique avant d'envoyer
	 * `RequestedPrice` : le tableau du Rec Center affiche 200 pour sf2 1518 (1000 à 80 %),
	 * et c'est 200 qu'il poste.
	 */
	StorefrontSaleData?: StorefrontSale | null
}

/** Le bloc `StorefrontSaleData` d'un prix de catalogue. Un `null` d'un côté ou de l'autre
 * (début ou fin) laisse la fenêtre ouverte de ce côté, ce que portent les captures. */
interface StorefrontSale {
	SalePercent: number
	SaleStartDate: string | null
	SaleEndDate: string | null
}
interface StoreItem {
	GiftDrop: StoreGiftDrop
	Prices: StorePrice[]
	/**
	 * The subscriber price list, where the catalog has one (sf300's item 2263 lists 95 tokens
	 * in `Prices` and 85 in here). A subscriber's client renders and posts this as
	 * `RequestedPrice`, so checking their buy against `Prices` alone 409s it as "Price has
	 * changed". Treated as a FLOOR rather than the price to expect, because the client also
	 * posts the FULL price for items whose two lists agree (sf3's 2208, 150/150) — see
	 * {@link priceCheck}.
	 */
	SubscriberPrices?: StorePrice[] | null
	PurchasableItemId: number
}

/**
 * The most Rec Room Plus can take off an item, in percent of the regular price.
 *
 * The client applies the discount ITSELF and posts the result as `RequestedPrice`, but it
 * does NOT apply it to everything: sf3's item 2208 is 150 tokens in both catalog lists and a
 * subscriber's client posts 150, while sf300's 2263 is 95/85 and posts 85. Only 144 of the
 * 1382 captured items carry a discounted `SubscriberPrices` at all, and whether the rest are
 * genuinely full price for a subscriber or were merely captured through a non-subscriber's
 * view isn't answerable from here. So the server doesn't predict the number: it accepts
 * anything from the regular price down to this much off (see {@link priceCheck}) and charges
 * what the client asked to pay. Deriving one exact subscriber price instead 409'd every buy
 * the client priced the other way.
 */
const SUBSCRIBER_DISCOUNT_PERCENT = 10

/** The lowest a subscriber's client can render an item whose regular price is `regular`. */
function subscriberFloor(regular: number): number {
	return Math.floor((regular * (100 - SUBSCRIBER_DISCOUNT_PERCENT)) / 100)
}

/**
 * The outcome of confirming a client's `RequestedPrice` against the catalog: the price to
 * actually charge, or why the line can't be sold.
 */
type PriceCheck =
	| { charge: number }
	/** The item isn't sold in the requested currency at all. */
	| 'no-currency'
	/** The catalog moved under a stale client, or the price was made up. */
	| 'mismatch'

/**
 * Confirms what the buyer's client rendered, and answers what to charge them.
 *
 * The price a client renders is a CHAIN, and each step is one the server has to reproduce:
 * the catalog price, then `StorefrontSaleData` while its window is open, then the Rec Room
 * Plus discount on top of THAT. The catalogues this server serves carry no sale at all
 * (`basePriceStorefront`), so in practice the chain collapses to the catalog price and the
 * Plus discount — the sale step stays because a client can hold a cached store page from
 * before, and the chain then has to be reproduced exactly as that client rendered it. The
 * captured refusals fix the order — sf2's 1518 was sent
 * as 180 (1000 at 80 % off = 200, minus the 10 % Plus discount), sf600's 1378 as 360 (2000
 * → 400 → 360) and sf102's 1562 as 144 (800 → 160 → 144). Checking `Prices` alone 409'd every
 * discounted item on the Rec Center board, which the player sees as the client's bare
 * "An error occurred".
 *
 * A non-subscriber pays the rendered price, exactly — or the catalog price, for the items the
 * client doesn't discount. A subscriber pays whatever they asked to pay within a BAND: the
 * catalog price at the top down to the catalog's `SubscriberPrices` entry or
 * {@link SUBSCRIBER_DISCOUNT_PERCENT} off the RENDERED price, whichever is lower. Charging
 * `RequestedPrice`
 * rather than a server-picked end of the band keeps the debit equal to the price the buyer was
 * shown, and the floor is what bounds the discount a modified client can shave off.
 */
function priceCheck(
	item: StoreItem,
	currencyType: number,
	subscriber: boolean,
	requestedPrice: unknown
): PriceCheck {
	const regular = item.Prices.find((p) => p.CurrencyType === currencyType)
	if (regular === undefined) return 'no-currency'
	if (!Number.isInteger(requestedPrice)) return 'mismatch'
	const requested = requestedPrice as number
	// Le prix catalogue : ce que le client poste pour un article qu'il ne remise pas.
	if (requested === regular.Price) return { charge: requested }
	const rendered = renderedPrice(regular, Date.now())
	// Le prix soldé, que poste un client sans Plus.
	if (requested === rendered) return { charge: requested }
	if (!subscriber) return 'mismatch'
	// Le plancher part de ce qui est AFFICHÉ : avec une solde, c'est 10 % sous le prix soldé
	// (180 pour sf2 1518), sinon 10 % sous le catalogue. Le `SubscriberPrices` du catalogue
	// (sf300 2089 : 95/85) reste une seconde borne basse — un client qui poste ce prix-là
	// plutôt que la solde est dans son droit, et c'est ce que le plafond ci-dessous borne.
	const listed = item.SubscriberPrices?.find((p) => p.CurrencyType === currencyType)
	const floor = Math.min(subscriberFloor(rendered), listed?.Price ?? regular.Price)
	return requested >= floor && requested < regular.Price ? { charge: requested } : 'mismatch'
}

/** La fenêtre de solde couvre-t-elle `now` ? Un côté manquant est ouvert de ce côté. */
function saleIsOpen(sale: StorefrontSale, now: number): boolean {
	const start = sale.SaleStartDate === null ? -Infinity : Date.parse(sale.SaleStartDate)
	const end = sale.SaleEndDate === null ? Infinity : Date.parse(sale.SaleEndDate)
	if (Number.isNaN(start) || Number.isNaN(end)) return false
	return start <= now && now < end
}

/**
 * Le prix que le client AFFICHE pour une entrée de catalogue : le prix soldé tant que la
 * fenêtre est ouverte, sinon le prix catalogue. `SalePercent` se déduit du prix catalogue.
 */
function renderedPrice(entry: StorePrice, now: number): number {
	const sale = entry.StorefrontSaleData
	if (!sale || !saleIsOpen(sale, now)) return entry.Price
	const percent = Math.min(100, Math.max(0, sale.SalePercent))
	return Math.round((entry.Price * (100 - percent)) / 100)
}

interface Storefront {
	StoreItems: StoreItem[]
}

/** The `Gift` block of a buyItem body — present when buying an item for another player. */
interface GiftRequest {
	ToPlayerId?: number
	Anonymous?: boolean
	Message?: string
	GiftContext?: number
}

/**
 * Storefront ids that are served ANOTHER storefront's catalog, because no capture of their
 * own exists yet. Placeholder: an alias here is a storefront this server hasn't got, not one
 * it has decided is a duplicate, so a line should come OUT again the moment `static/storefronts`
 * grows the real `sf{id}.json` — the alias silently wins over a file of that name.
 *
 * Resolved in {@link storefrontAssetPath} rather than at the route, so an aliased storefront
 * is aliased for BUYING too. Browsing and purchasing read the same catalog by id, and an
 * alias applied to only the browse side would show a page of items whose every purchase
 * 404s as "no such storefront".
 */
const STOREFRONT_ALIASES: Record<string, string> = {
	// Empty. 1704 was here for a while, standing in for a 2025 gift-drop storefront nobody had
	// captured; the 2025 general store has since been dumped and is served as storefront 3 —
	// see {@link STOREFRONT_BY_BUILD}.
	// That is a per-BUILD variant of one storefront rather than an alias between two ids, which
	// is why nothing is listed here.
}

/**
 * Storefronts that have a SECOND file for newer clients, keyed by the id the client asks for
 * and naming the file a build past {@link LEGACY_CLIENT_BUILD} is served instead.
 *
 * `3` is the general store at two points in time. `sf3.json` is the 2023 store, frozen;
 * `sf3-2025.json` is the real 2025 store — a dump of the live game's storefront 3, written by
 * `runx storefront build` with its captured sale stripped (see that command). One storefront
 * id either way: the client asks for 3 in both cases and neither knows there are two files, so
 * nothing about the request changes. The two files number their items differently — each is
 * the store its build actually had — and nothing crosses between them.
 *
 * Resolved in {@link storefrontAssetPath}, which BOTH the listing route and
 * {@link loadStorefront} go through, so browsing and buying always read the same file. That is
 * the whole reason it is not done at the route: a newer client shown the 2025 store and then
 * charged against the 2023 one would have every purchase 404 as "no such storefront".
 */
const STOREFRONT_BY_BUILD: Record<string, string> = {
	'3': 'sf3-2025',
}

/**
 * The ASSETS path a storefront id reads from, following any {@link STOREFRONT_ALIASES} entry
 * and any {@link STOREFRONT_BY_BUILD} variant. The id arrives as a path param, so it is a
 * string here rather than a number: both tables are matched on what the client asked for.
 *
 * `build` is the caller's `rn.ver` (see {@link authedBuild}), or null when there is no readable
 * one. Null gets the captured file: an unversioned token is the OLD client, so treating "can't
 * prove its version" as "newer" would swap the store out from under the build that needs it.
 */
function storefrontAssetPath(id: string, build: number | null): string {
	const aliased = STOREFRONT_ALIASES[id] ?? id
	const variant = STOREFRONT_BY_BUILD[aliased]
	// A build past LEGACY_CLIENT_BUILD gets the newer file; the 2023 build — and a caller whose
	// version can't be read, which is the old client — keeps the frozen 2023 store. The two
	// catalogs number their items differently, so serving the newer one to an old build is not a
	// cosmetic mismatch: the Rec Center's shop slots carry 2023 ids, and every one of them comes
	// back "Item not found" from `buyItem`. The client shows that as a bare "An error occurred"
	// and leaves its purchase guard set, so the shop then says a purchase is already in progress.
	if (variant !== undefined && build !== null && build > LEGACY_CLIENT_BUILD) {
		return `/${variant}.json`
	}
	return `/sf${aliased}.json`
}

/**
 * L'item « REC BLUE Plus » — l'abonnement vendu EN TOKENS dans la boutique du jeu.
 *
 * C'est le seul item du catalogue qui ne donne aucun objet : l'acheter pose le Plus sur le
 * compte de celui qui le reçoit (voir {@link grantRecBluePlus}). Il est ajouté au catalogue
 * servi plutôt que dans les fichiers `sf*.json`, pour que la boutique de 2023 comme celle
 * de 2025 le proposent sans dupliquer l'item dans deux exports figés.
 *
 * Le prix est celui des skins du haut de gamme (1000–6000 tokens) : c'est un abonnement
 * mensuel payé en argent du jeu, pas une monnaie réelle.
 */
const REC_BLUE_PLUS_ITEM_ID = 990001
const REC_BLUE_PLUS_PRICE = 5000
const REC_BLUE_PLUS_DAYS = 30

/**
 * Un item fabriqué de toutes pièces, dans la FORME EXACTE d'un item du catalogue.
 *
 * Le client décode `StoreItem` avec un schéma strict : un item auquel il manque `Type`,
 * `IsFeatured`, `CanBeGifted` ou `ThumbnailImageName` est rejeté, et un item rejeté ne
 * s'affiche pas du tout dans la boutique (c'est ce qui est arrivé avec la première
 * version, écrite à la main). On part donc d'un item réel du même catalogue — celui que
 * le joueur regarde — et on n'écrase que ce qui nous appartient : l'identité, le nom et
 * le prix. Tout le reste (contexte de rayon, type, champs optionnels) est hérité du
 * catalogue, donc forcément valide pour ce build.
 */
function syntheticStoreItem(
	template: StoreItem | undefined,
	id: number,
	name: string,
	tooltip: string,
	price: number,
	tokens: number
): StoreItem {
	const item = JSON.parse(
		JSON.stringify(template ?? FALLBACK_STORE_ITEM)
	) as Record<string, any>
	item.PurchasableItemId = id
	item.Prices = [{ CurrencyType: CurrencyType.RecCenterTokens, Price: price, StorefrontSaleData: null }]
	item.SubscriberPrices = null
	const drop = item.GiftDrop as Record<string, any>
	drop.GiftDropId = id
	drop.FriendlyName = name
	drop.Tooltip = tooltip
	drop.ConsumableItemDesc = ''
	drop.AvatarItemDesc = ''
	drop.CustomAvatarItemId = null
	drop.AvatarItemType = null
	drop.EquipmentPrefabName = ''
	drop.EquipmentModificationGuid = ''
	drop.IsQuery = false
	drop.QueryRedirectContext = null
	drop.QueryRedirectTag = null
	drop.QueryRedirectRarity = null
	drop.Unique = false
	drop.SubscribersOnly = false
	drop.Rarity = -1
	drop.Currency = tokens
	drop.CurrencyType = tokens > 0 ? CurrencyType.RecCenterTokens : 0
	drop.ItemCount = 1
	drop.ItemSetId = 0
	drop.ItemSetFriendlyName = ''
	drop.AvatarItemId = 0
	drop.EquipmentItemId = 0
	drop.ThumbnailImageName = ''
	drop.AvatarItemInfo = null
	// Les articles maison (abonnement, bundles) sont PERMANENTS : ils ne doivent pas hériter
	// d'une fenêtre de disponibilité du premier article du catalogue, sans quoi l'abonnement
	// expirerait avec la boutique thématique du moment (voir halloween-shop.ts).
	item.AvailableAt = null
	item.AvailableUntil = null
	return item as unknown as StoreItem
}

/** La forme d'un item de boutique, pour le cas où le catalogue serait illisible. */
const FALLBACK_STORE_ITEM = {
	PurchasableItemId: 0,
	Type: 0,
	GiftDrop: {
		GiftDropId: 0,
		FriendlyName: '',
		Tooltip: '',
		TagList: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		CustomAvatarItemId: null,
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		IsQuery: false,
		QueryRedirectContext: null,
		QueryRedirectTag: null,
		QueryRedirectRarity: null,
		Unique: false,
		SubscribersOnly: false,
		Rarity: -1,
		Context: 0,
		Currency: 0,
		CurrencyType: 0,
		ItemCount: 1,
		ItemSetId: 0,
		ItemSetFriendlyName: '',
		AvatarItemId: 0,
		EquipmentItemId: 0,
		ThumbnailImageName: '',
		AvatarItemInfo: null,
	},
	Prices: [],
	SubscriberPrices: null,
	IsFeatured: false,
	NewUntil: null,
	AvailableAt: null,
	AvailableUntil: null,
	CanBeGifted: true,
	OnlyAvailableThroughCv2: false,
} as unknown as StoreItem

function recBluePlusItem(template?: StoreItem): StoreItem {
	return syntheticStoreItem(
		template,
		REC_BLUE_PLUS_ITEM_ID,
		'REC BLUE Plus (30 jours)',
		'L abonnement REC BLUE Plus pendant 30 jours : tenues réservées au Plus, remise de 10 % et crédits de niveau débloqués.',
		REC_BLUE_PLUS_PRICE,
		0
	)
}

/**
 * Ajoute l'item REC BLUE Plus au catalogue de la boutique GÉNÉRALE (storefront 1, et son
 * équivalent 2025 sous l'id 3). Les autres storefronts — sets d'objets, bundles de tokens —
 * n'en vendent pas.
 */
function withRecBluePlus(storefront: Storefront, storefrontType: number): Storefront {
	if (storefrontType !== 1 && storefrontType !== 3) return storefront
	if (storefront.StoreItems.some((it) => it.PurchasableItemId === REC_BLUE_PLUS_ITEM_ID)) return storefront
	// Hérité d'un item réel de CE catalogue : la forme que ce build sait décoder.
	const template = storefront.StoreItems[0]
	return {
		...storefront,
		StoreItems: [
			...storefront.StoreItems,
			recBluePlusItem(template),
			...Object.entries(REC_BLUE_BUNDLES).map(([id, bundle]) =>
				recBlueBundleStoreItem(Number(id), bundle, template)
			),
		],
	}
}

/**
 * Les teintures de cheveux permanentes, vendues à PRIX FIXE dans la boutique générale (3).
 *
 * Le catalogue 2025 (`sf3-2025.json`) les liste ; le catalogue 2023 servi au build 20230414
 * (`sf3.json`) ne les a pas du tout, donc le magasin de ce client ne les proposait pas. Elles
 * sont ajoutées au moment de servir plutôt que dans `sf3.json`, qui reste la capture du
 * magasin d'origine. Le client 2023 les connaît — son `resources.assets` embarque le
 * catalogue des teintures (« Rebel Rose Hair Dye » et son GUID `AvatarItemDesc`) — donc
 * `AvatarItemType: 1` et un desc compact sont exactement ce qu'il attend ; les ids
 * 1195–1257 sont sous la plage du catalogue 2023 (2168+), donc aucune collision.
 *
 * Prix : 5000 tokens la bouteille, comme tout le magasin au prix de base — les soldes du
 * catalogue 2025 sont retirées par `basePriceStorefront` (storefront-pricing.ts). Comme pour
 * chaque article, un membre Rec Room Plus paie 10 % de moins (4500), et rien d'autre.
 *
 * Le fichier porte aussi les trois potions de couleur TEMPORAIRES (« Hair Pulse » — bleu,
 * orange, rouge), au même prix fixe de 5000 (4500 en Plus). Elles sont des consommables
 * (`ConsumableItemDesc`, pas d'`AvatarItemDesc`), pas des déblocages permanents. Le catalogue
 * 2025 les vend à 150/135 tokens : c'est justement pour ça que le prix des entrées DÉJÀ
 * listées est réécrit au passage, et pas seulement celui des entrées ajoutées — sinon le même
 * pot coûterait 5000 sur le build 2023 et 150 sur un build récent.
 */
const HAIR_DYE_ASSET = '/rec-blue-hair-dye.json'

async function withRecBlueHairDye(
	c: Context<App>,
	storefront: Storefront,
	storefrontType: number
): Promise<Storefront> {
	if (storefrontType !== 3) return storefront
	const res = await c.env.ASSETS.fetch(new URL(HAIR_DYE_ASSET, c.req.url))
	// Un asset absent ne doit pas casser la boutique : on sert le catalogue tel quel.
	if (!res.ok) return storefront
	const products = (await res.json()) as StoreItem[]
	const fixedPrice = new Map(products.map((item) => [item.PurchasableItemId, item]))
	// Le catalogue 2025 liste déjà les potions « Hair Pulse », à son propre prix : on réécrit
	// le prix de ces entrées au lieu de les dupliquer, pour qu'un pot coûte le prix fixe quel
	// que soit le build du client.
	const items = storefront.StoreItems.map((item) => {
		const priced = fixedPrice.get(item.PurchasableItemId)
		if (priced === undefined) return item
		return { ...item, Prices: priced.Prices, SubscriberPrices: priced.SubscriberPrices }
	})
	// Les teintures, elles, manquent au catalogue 2023 : elles s'ajoutent.
	const known = new Set(items.map((item) => item.PurchasableItemId))
	const missing = products.filter((item) => !known.has(item.PurchasableItemId))
	return { ...storefront, StoreItems: [...items, ...missing] }
}

const SKINS_ASSET = '/rec-blue-skins.json'

/** Les vitrines de l'onglet « Skins » du magasin, et la boutique générale (3). */
const SKIN_PAGES = [401, 402, 403, 404, 405, 406] as const
const SKIN_STOREFRONTS = new Set<number>([3, ...SKIN_PAGES])

/**
 * Les skins d'équipement (« Plaid Paintball Pistol Skin », « Shield Skin (Gold) »…) dans la
 * boutique générale (3) et dans l'onglet « Skins » (401 à 406).
 *
 * Le catalogue 2023 servi au build 20230414 n'en contient AUCUNE : ce client n'avait pas une
 * seule skin en magasin, alors que le catalogue 2025 en liste 284 (les 99 du vrai magasin plus
 * celles que `runx storefront build` ajoute depuis `static/db/skins.json`).
 * `rec-blue-skins.json` reprend ces listings — sauf les 3 que le dump ne price pas, donc
 * invendables — sous des ids NEUFS (2 000 001+), parce que les petits ids du catalogue 2025
 * désignent d'autres objets dans le catalogue 2023.
 *
 * Le dédoublonnage se fait sur `EquipmentModificationGuid`, jamais sur l'id : un build récent
 * reçoit déjà ces skins de son propre catalogue, avec ses ids, et n'a donc rien à ajouter — son
 * prix est simplement aligné sur le nôtre, ce qui rend enfin achetables les deux Maker Pen que
 * le dump laisse sans prix (`SUPER PUMA Maker Pen` 3000, `Creator Expo 2025 Makerpen Skin`
 * 5000) et garde un même prix sur les deux builds. Le prix est celui du vrai magasin — 3000
 * tokens pour la plupart, 5 000 000 pour les treize skins « (Gold) » — et la remise Rec Room
 * Plus reste la seule, bornée à l'achat par `priceCheck`.
 */
async function withRecBlueSkins(
	c: Context<App>,
	storefront: Storefront,
	storefrontType: number
): Promise<Storefront> {
	if (!SKIN_STOREFRONTS.has(storefrontType)) return storefront
	const res = await c.env.ASSETS.fetch(new URL(SKINS_ASSET, c.req.url))
	// Un asset absent ne doit pas casser la boutique : on sert le catalogue tel quel.
	if (!res.ok) return storefront
	const skins = (await res.json()) as StoreItem[]
	// L'onglet « Skins » (401 à 406) : le catalogue est RÉPARTI sur les six pages — tri stable
	// par outil puis par nom, puis un article sur six. Les six ensemble servent donc tout le
	// catalogue sans doublon, et chaque page garde un éventail d'outils. Les 284 articles servis
	// à l'identique dans CHAQUE page ne faisaient au contraire apparaître que ce que la page
	// veut bien dessiner (les skins Maker Pen, en 36e position, n'apparaissaient jamais).
	if (storefrontType !== 3) {
		const ordered = [...skins].sort(
			(a, b) =>
				a.GiftDrop.EquipmentPrefabName.localeCompare(b.GiftDrop.EquipmentPrefabName) ||
				a.GiftDrop.FriendlyName.localeCompare(b.GiftDrop.FriendlyName)
		)
		const page = storefrontType - SKIN_PAGES[0]
		return { ...storefront, StoreItems: ordered.filter((_, index) => index % SKIN_PAGES.length === page) }
	}
	const byGuid = new Map(skins.map((item) => [item.GiftDrop.EquipmentModificationGuid, item]))
	// Un catalogue qui liste déjà la skin garde SON article, mais prend notre prix : c'est ce
	// qui rend achetables les deux Maker Pen sans prix, sur les deux builds à la fois.
	const items = storefront.StoreItems.map((item) => {
		const priced = byGuid.get(item.GiftDrop.EquipmentModificationGuid)
		if (priced === undefined) return item
		return { ...item, Prices: priced.Prices, SubscriberPrices: priced.SubscriberPrices }
	})
	const known = new Set(
		items.map((item) => item.GiftDrop.EquipmentModificationGuid).filter((guid) => guid !== '')
	)
	const missing = skins.filter((item) => !known.has(item.GiftDrop.EquipmentModificationGuid))
	// Les skins passent DEVANT, et c'est un choix d'affichage, pas de tri : le magasin
	// général sert plus de 3 000 articles, donc une skin rangée en fin de liste n'était
	// trouvable par personne — « il manque des skins » alors qu'elles étaient toutes servies.
	// Un achat n'y perd rien : chaque case garde son propre id et son propre article.
	return { ...storefront, StoreItems: [...missing, ...items] }
}

/** Les extras maison d'un catalogue : teintures et potions, puis les skins d'équipement. */
async function withRecBlueExtras(
	c: Context<App>,
	storefront: Storefront,
	storefrontType: number
): Promise<Storefront> {
	const hair = await withRecBlueHairDye(c, storefront, storefrontType)
	return withRecBlueSkins(c, hair, storefrontType)
}

/**
 * Les offres « bundle » du magasin, vendues EN TOKENS puisqu'un achat en argent réel est
 * refusé par le client (le Token Store répond « You are not allowed to make in-app
 * purchases »). Le prix en tokens reprend l'offre d'origine au taux du jeu (≈ 550 tokens
 * pour 1 $), arrondi : 69,99 $ → 38 500, 19,99 $ → 17 000, 9,99 $ → 5 750.
 *
 * `items` nomme les pièces RÉELLEMENT au catalogue, retrouvées par leur nom à l'achat :
 * les deux catalogues (2023 et 2025) numérotent leurs items différemment, mais gardent les
 * mêmes noms, donc un bundle marche sur les deux sans table d'ids parallèle.
 */
interface RecBlueBundle {
	name: string
	tooltip: string
	price: number
	items: string[]
	/** Tokens crédités avec le bundle, dans leur propre boîte. */
	tokens: number
}

const REC_BLUE_BUNDLES: Record<number, RecBlueBundle> = {
	990002: {
		name: 'Rec Trooper Bundle',
		tooltip: 'Les cinq sets Rec Trooper complets : casque, gilet et gants (rouge, bleu, jaune, rose, noir).',
		price: 38500,
		tokens: 0,
		items: [
			'Rec Trooper Helmet (Red)',
			'Rec Trooper Vest (Red)',
			'Rec Trooper Gloves (Red)',
			'Rec Trooper Helmet (Blue)',
			'Rec Trooper Vest (Blue)',
			'Rec Trooper Gloves (Blue)',
			'Rec Trooper Helmet (Yellow)',
			'Rec Trooper Vest (Yellow)',
			'Rec Trooper Gloves (Yellow)',
			'Rec Trooper Helmet (Pink)',
			'Rec Trooper Vest (Pink)',
			'Rec Trooper Gloves (Pink)',
			'Rec Trooper Helmet (Black)',
			'Rec Trooper Vest (Black)',
			'Rec Trooper Gloves (Black)',
		],
	},
	990003: {
		// La paire de RecPods de l'offre d'origine n'existe pas dans les catalogues servis :
		// le bundle ne vend que les tokens, au prix de l'offre (5 500 pour 5 750).
		name: '5 500 Tokens',
		tooltip: 'Un sac de 5 500 tokens, au tarif du pack du jeu.',
		price: 5750,
		tokens: 5500,
		items: [],
	},
	990004: {
		// La « 5 Star Unique Box » de l'offre d'origine n'existe pas au catalogue (les boîtes
		// vont de 2 à 4 étoiles) : c'est la 4 étoiles qui la remplace.
		name: 'Weekly Bundle: 5 Star Bundle',
		tooltip: 'La boîte 4 étoiles et 16 000 tokens de la semaine.',
		price: 17000,
		tokens: 16000,
		items: ['4-Star Unique Box'],
	},
}

function bundleById(id: number): RecBlueBundle | undefined {
	return REC_BLUE_BUNDLES[id]
}

function recBlueBundleStoreItem(
	id: number,
	bundle: RecBlueBundle,
	template?: StoreItem
): StoreItem {
	return syntheticStoreItem(template, id, bundle.name, bundle.tooltip, bundle.price, bundle.tokens)
}

/**
 * Le contenu d'un bundle est PAYÉ ici, en une boîte par pièce plus une boîte pour les
 * tokens — `Currency` sur un gift drop est crédité par `grantGiftDrop`, c'est ce que fait
 * déjà la boîte de passage de niveau.
 */
async function grantRecBlueBundle(
	c: Context<App>,
	accountId: number,
	bundle: RecBlueBundle
): Promise<void> {
	const message = `REC BLUE : ${bundle.name}`
	const storefront = await loadStorefront(c, 3)
	for (const name of bundle.items) {
		const found = storefront?.StoreItems.find((it) => it.GiftDrop.FriendlyName === name)
		if (found === undefined) continue
		const granted = await grantGiftDrop(c, accountId, found.GiftDrop, message)
		await pushGiftReceived(c, accountId, granted, message, COACH_ACCOUNT_ID)
	}
	if (bundle.tokens > 0) {
		const drop: StoreGiftDrop = {
			...syntheticStoreItem(undefined, 0, bundle.name, bundle.tooltip, bundle.price, bundle.tokens)
				.GiftDrop,
			Currency: bundle.tokens,
			CurrencyType: CurrencyType.RecCenterTokens,
		}
		const granted = await grantGiftDrop(c, accountId, drop, message)
		await pushGiftReceived(c, accountId, granted, message, COACH_ACCOUNT_ID)
	}
	logger.info('rec blue bundle granted', { accountId, bundle: bundle.name })
}

/**
 * Pose (ou prolonge) le Plus sur un compte : 30 jours à partir de la fin actuelle s'il en
 * reste, du moment présent sinon. `hasPlus` et `plusUntil` vont ensemble — c'est le drapeau
 * que le site et `auth` lisent — et `isSubscriber` relit ce même champ, donc la remise et
 * les items réservés au Plus s'appliquent dès l'achat, sans reconnexion.
 */
async function grantRecBluePlus(c: Context<App>, accountId: number): Promise<void> {
	const { readAccountFlags, setPlus } = await import('./site-flags')
	const flags = await readAccountFlags(c.env.DB, accountId)
	const current = flags.plusUntil === null ? Number.NaN : Date.parse(flags.plusUntil)
	const start = Number.isNaN(current) || current < Date.now() ? Date.now() : current
	const until = new Date(start + REC_BLUE_PLUS_DAYS * 24 * 60 * 60 * 1000).toISOString()
	await setPlus(c.env.DB, accountId, until)
	logger.info('rec blue plus granted', { accountId, until })
}

/**
 * Read a storefront catalog from the ASSETS binding — WHICH file depending on the caller's
 * build, see {@link storefrontAssetPath}. Null when there is no such storefront.
 *
 * Separate from {@link findStoreItem} so a caller resolving SEVERAL items from one
 * storefront reads (and parses) it once: sf3 alone is over two thousand items and sf3-2025
 * over three, and a bulk purchase carries up to `BULK_PURCHASE_CAP` lines.
 */
/** L'id du tableau du Rec Center, la seule vitrine dont les articles sont câblés un par case. */
const REC_CENTER_BOARD_STOREFRONT = 2

/**
 * Le catalogue d'une vitrine, boutique Halloween comprise (voir halloween-shop.ts) : la
 * sélection du moment à la place du catalogue pendant l'évènement, le catalogue tel quel
 * sinon. Appliqué aux DEUX chemins (servi et acheté), sinon ce qui est affiché et ce qui est
 * facturé divergeraient.
 */
async function themedCatalog(
	c: Context<App>,
	catalog: Storefront,
	storefrontType: number,
	build: number | null
): Promise<Storefront> {
	if (!halloweenIsLive(c.env.HALLOWEEN_SHOP)) return catalog
	// Le tableau du Rec Center ne vend aucun article Halloween dans son propre fichier : la
	// sélection est puisée dans le magasin général du MÊME build.
	if (storefrontType === REC_CENTER_BOARD_STOREFRONT) {
		const res = await c.env.ASSETS.fetch(new URL(storefrontAssetPath('3', build), c.req.url))
		if (res.ok) {
			// Les extras maison compris : deux cases du tableau servent les Maker Pen, qui ne sont
			// dans aucun `sf*.json` (`rec-blue-skins.json` les ajoute).
			const source = await withRecBlueSkins(
				c,
				basePriceStorefront((await res.json()) as Storefront),
				3
			)
			return halloweenCatalog(catalog, storefrontType, c.env.HALLOWEEN_SHOP, Date.now(), source)
		}
	}
	return halloweenCatalog(catalog, storefrontType, c.env.HALLOWEEN_SHOP)
}

async function loadStorefront(c: Context<App>, storefrontType: number): Promise<Storefront | null> {
	const build = await authedBuild(c)
	const res = await c.env.ASSETS.fetch(
		new URL(storefrontAssetPath(String(storefrontType), build), c.req.url)
	)
	if (!res.ok) return null
	// Les prix de base sont appliqués ICI, le chemin que lit aussi l'achat : le prix que le
	// joueur a vu sur le tableau est donc celui que `priceCheck` vérifie. La rotation du jour
	// vient juste après les prix, et AVANT la thématisation : l'évènement Halloween garde sa
	// sélection et sa date de fin tant qu'il dure (voir daily-storefront.ts).
	const catalog = dailyStorefront(basePriceStorefront((await res.json()) as Storefront))
	// La boutique Halloween remplace le catalogue AVANT les extras maison : l'abonnement REC
	// BLUE Plus, les bundles et les teintures restent achetables pendant l'évènement.
	const themed = await themedCatalog(c, catalog, Number(storefrontType), build)
	const extras = await withRecBlueExtras(c, themed, Number(storefrontType))
	return withRecBluePlus(extras, Number(storefrontType))
}

/**
 * Look up a store item by (storefront type, purchasable item id), reading the catalog
 * from the ASSETS binding (`sf{type}.json`). Returns null when there is no such
 * storefront or no item with that id in it.
 */
async function findStoreItem(
	c: Context<App>,
	storefrontType: number,
	purchasableItemId: number
): Promise<StoreItem | null> {
	const storefront = await loadStorefront(c, storefrontType)
	// L'abonnement et les bundles ne sont dans aucun fichier de catalogue : ils sont ajoutés
	// à la volée, donc l'achat doit les résoudre ici aussi (et pas seulement à l'affichage).
	if (bundleById(purchasableItemId) !== undefined) {
		const bundle = bundleById(purchasableItemId) as RecBlueBundle
		return recBlueBundleStoreItem(purchasableItemId, bundle, storefront?.StoreItems[0])
	}
	if (purchasableItemId === REC_BLUE_PLUS_ITEM_ID) {
		return recBluePlusItem(storefront?.StoreItems[0])
	}
	if (storefront === null) return null
	return storefront.StoreItems.find((it) => it.PurchasableItemId === purchasableItemId) ?? null
}

/**
 * How one item may be bought, as `POST /api/items/purchaseInfos` answers it. The store row
 * holds ids only, so everything a price tag needs comes from here.
 *
 * `ItemId` re-uses the request's reference verbatim — camelCase members under a PascalCase
 * key. It reads like a mistake and is not one: the client's decoder names the members that
 * way on both legs, and PascalCasing them here loses the id.
 *
 * `PurchaseMethodId` names WHICH listing sells the item, and is a tagged union of the two
 * kinds of id a listing can have: `Type` 1 carries a `Guid` (a UGC item, keyed by its own
 * guid) and leaves `NumberId` null; a storefront's numbered `PurchasableItemId` would be the
 * other side. Nothing here sells anything under a second listing, so the guid is the item's own.
 */
interface ItemPurchaseInfo {
	ItemId: { itemType: number; itemId: string }
	PurchaseMethodId: { Type: number; NumberId: number | null; Guid: string | null }
	Prices: Array<{
		CurrencyType: number
		Price: number
		StorefrontSaleData: {
			SalePercent: number
			SaleStartDate: string | null
			SaleEndDate: string | null
		} | null
	}>
	NewUntil: string | null
	AvailableAt: string | null
	AvailableUntil: string | null
	CanBeGifted: boolean
	CanApplySubscriberDiscount: boolean
	SubscribersOnly: boolean
	IsFeatured: boolean
}

/** The `PurchaseMethodId.Type` that carries a `Guid` rather than a `NumberId`. */
const PURCHASE_METHOD_TYPE_GUID = 1

/**
 * The purchase-info projection of a custom avatar item.
 *
 * The price is in `RecCenterTokens` because that is what a UGC item costs: the creation UI's
 * floor (`api`'s `/api/customAvatarItems/v1/minPriceForPublicItem`) is a token price, and the
 * `price` column it writes is the same number. It must NOT be a room currency — those are
 * scoped to a room this endpoint knows nothing about, and the client holds no balance to pay
 * one with, so the item would draw a price it can never meet. The one exception is a TICKET
 * REWARD (`PurchaseCurrencyType`, set by the load from the storefront dumps): it is priced in
 * its game's currency, as that game's store lists it, because tokens never buy it.
 *
 * The rest is what the row can honestly say:
 *  - `AvailableAt` is the item's creation — the moment it began being sellable. There is no
 *    scheduled listing here, so `AvailableUntil` is null: on sale until the creator pulls it.
 *  - `NewUntil` is null rather than derived from `CreatedAt`: nothing has ever defined how long
 *    “new” lasts here, and guessing draws the pip on items that are not.
 *  - `StorefrontSaleData` is a zero-percent sale rather than null, since nothing discounts UGC
 *    items yet and a present-but-empty sale is the shape the client always gets to read.
 *  - `SubscribersOnly`/`CanApplySubscriberDiscount` are false: subscriber pricing is a
 *    storefront-catalog feature (`sf{N}.json`'s `SubscriberPrices`) and no UGC item has one.
 *  - `IsFeatured` is the row's own flag, the same one the featured feed reads.
 *
 * `CanBeGifted` is true because the reference let players gift UGC items — but nothing here
 * buys a custom avatar item yet, gift or otherwise, so the button it draws leads nowhere until
 * that exists. It is the flag to flip if a dead gift button is worse than a missing one.
 */
function toItemPurchaseInfo(item: CustomAvatarItem): ItemPurchaseInfo {
	return {
		ItemId: { itemType: UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM, itemId: item.CustomAvatarItemId },
		PurchaseMethodId: {
			Type: PURCHASE_METHOD_TYPE_GUID,
			NumberId: null,
			Guid: item.CustomAvatarItemId,
		},
		Prices: [
			{
				// A ticket reward is priced in its own game's currency, as its storefront lists it.
				CurrencyType: item.PurchaseCurrencyType ?? CurrencyType.RecCenterTokens,
				Price: item.Price,
				StorefrontSaleData: { SalePercent: 0, SaleStartDate: null, SaleEndDate: null },
			},
		],
		NewUntil: null,
		AvailableAt: item.CreatedAt,
		AvailableUntil: null,
		CanBeGifted: true,
		CanApplySubscriberDiscount: false,
		SubscribersOnly: false,
		IsFeatured: item.IsFeatured,
	}
}

/** Build the owned avatar-item DTO granted into the buyer's inventory from a gift-drop. */
function toAvatarItem(giftDrop: StoreGiftDrop): AvatarItem {
	return {
		AvatarItemType: giftDrop.AvatarItemType,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		PlatformMask: -1,
		FriendlyName: giftDrop.FriendlyName,
		Tooltip: giftDrop.Tooltip ?? '',
		Rarity: giftDrop.Rarity,
	}
}

/** Build the owned equipment DTO granted into the buyer's inventory from a gift-drop. */
function toEquipment(giftDrop: StoreGiftDrop): Equipment {
	return {
		ModificationGuid: giftDrop.EquipmentModificationGuid,
		PrefabName: giftDrop.EquipmentPrefabName,
		FriendlyName: giftDrop.FriendlyName,
		Tooltip: giftDrop.Tooltip ?? '',
		Rarity: giftDrop.Rarity,
		PlatformMask: -1,
		Favorited: false,
	}
}

/** Quantity of a consumable granted per purchase — our storefront catalogs don't specify one. */
const CONSUMABLE_GRANT_COUNT = 1

/** The "Coach" system account — the sender a self-buy or anonymous gift is attributed to. */
const COACH_ACCOUNT_ID = 1

/** What a box says when the buyer wrote nothing — a self-purchase, or a gift sent bare. */
const DEFAULT_GIFT_MESSAGE = 'A gift for you <3'

/**
 * The most a gift note may carry — the same 150 the client's own input field stops typing at,
 * so a longer one is a client that ignored its own limit rather than a longer note.
 */
const MAX_GIFT_MESSAGE_LENGTH = 150

/**
 * The note a gift box carries: capped at {@link MAX_GIFT_MESSAGE_LENGTH}, then masked the way
 * every other string a player typed is.
 *
 * The buyer writes this and someone ELSE reads it — off the box, out of the hub frame, and
 * for as long as the box goes unopened — so a gift is a way to put text in front of a player
 * who never chose to hear from you. That is why both rules are re-applied here: nothing
 * obliges a client to have called `POST /api/sanitize/v1` first, or to have honoured its own
 * character limit, and this is the last point before the note is stored. `chat` censors its
 * messages again for the same reason.
 *
 * Trimming and masking (rather than refusing) matches the rest of this server: the purchase
 * goes through, the swear comes out as asterisks, the overrun is dropped, and the buyer is
 * never told their gift was rejected. Blocked characters are deliberately left alone, as in
 * chat — a note is emoji-carrying text, and stripping format characters would break the
 * joiners inside a multi-person emoji.
 *
 * The cap is applied FIRST so what gets filtered is what gets stored: cutting a word in half
 * can leave a swear where there wasn't one ("assassin" ending as "ass"), and cutting after
 * the mask would leave a half-masked word instead. Both counts are UTF-16 units, as the
 * client's are — a trailing lone surrogate is dropped rather than stored as half a character.
 */
function giftMessage(gift: GiftRequest | null): string {
	if (typeof gift?.Message !== 'string') return DEFAULT_GIFT_MESSAGE
	return censorSwears(truncateGiftMessage(gift.Message))
}

/** `message` cut to the cap, never through the middle of a surrogate pair. */
function truncateGiftMessage(message: string): string {
	if (message.length <= MAX_GIFT_MESSAGE_LENGTH) return message
	const cut = message.slice(0, MAX_GIFT_MESSAGE_LENGTH)
	const last = cut.charCodeAt(cut.length - 1)
	// A high surrogate at the end lost its partner to the cut, and alone it is not a
	// character at all — the client would draw the replacement glyph for it.
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * Build the stored gift-box content (the client's rendered "gift box") from a gift-drop.
 *
 * `fromPlayerId` and `giftContext` are stamped on because the box outlives the request that
 * made it: a gift's receiver may well be offline and meets it in `GET /api/avatar/v2/gifts`,
 * with nothing but the row to say who sent it or why. They default to Coach and the drop's
 * own context — a box the server handed over on nobody's behalf.
 */
/**
 * `AvatarItemType` as a gift box carries it: the drop's own (0 when it names none) for an
 * AVATAR ITEM — a baked one by `AvatarItemDesc` or a custom one by `CustomAvatarItemId` — and
 * NULL for anything else: a consumable, a skin, a box, a token bundle.
 *
 * The client routes a box by this field before it looks at what else the box names: a 0
 * reads as "an avatar item of type 0", and a consumable or skin box sent with 0 fails with
 * "can't find avatar item" because there is no such item to find. The 2025 store lists every
 * non-avatar drop with `AvatarItemType: null` for exactly that reason, and this is what the
 * old `?? 0` coalescing used to erase. A custom item's box is the other way round: it needs
 * the number, as the bag's guid-keyed box ({@link toCustomGiftContent}) sends it. Applied at
 * every surface a box is serialized on — the stored box, both purchase responses and the hub
 * frame — so they cannot disagree.
 */
function boxAvatarItemType(drop: StoreGiftDrop): number | null {
	const isAvatarItem =
		drop.AvatarItemDesc !== '' ||
		(typeof drop.CustomAvatarItemId === 'string' && drop.CustomAvatarItemId !== '')
	return isAvatarItem ? (drop.AvatarItemType ?? 0) : null
}

function toGiftContent(
	giftDrop: StoreGiftDrop,
	message: string,
	consumableCount: number,
	consumableMappingId = 0,
	consumablePreExistingCount = 0,
	fromPlayerId = COACH_ACCOUNT_ID,
	giftContext: number | null = null
): GiftContent {
	return {
		FromPlayerId: fromPlayerId,
		GiftContext: giftContext ?? giftDrop.Context,
		ConsumableItemDesc: giftDrop.ConsumableItemDesc,
		ConsumableCount: consumableCount,
		ConsumableMappingId: consumableMappingId,
		ConsumablePreExistingCount: consumablePreExistingCount,
		AvatarItemDesc: giftDrop.AvatarItemDesc,
		AvatarItemType: boxAvatarItemType(giftDrop),
		CurrencyType: giftDrop.CurrencyType,
		Currency: giftDrop.Currency,
		Xp: giftDrop.Xp ?? 0,
		PackageType: 0,
		Message: message,
		EquipmentPrefabName: giftDrop.EquipmentPrefabName,
		EquipmentModificationGuid: giftDrop.EquipmentModificationGuid,
		GiftRarity: giftDrop.Rarity,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
}

/**
 * The stored gift box for a bought CUSTOM avatar item: the item named by
 * `CustomAvatarItemId` where a catalog box names an `AvatarItemDesc`, every other item field
 * empty. A custom item is no storefront drop, so it has no rarity of its own, and its context
 * is the `Gift` block's or 0. `fromPlayerId` is routed as {@link toGiftContent}'s is.
 */
function toCustomGiftContent(
	item: CustomAvatarItem,
	message: string,
	fromPlayerId: number,
	giftContext: number | null
): GiftContent {
	return {
		FromPlayerId: fromPlayerId,
		GiftContext: giftContext ?? 0,
		ConsumableItemDesc: '',
		ConsumableCount: 0,
		AvatarItemDesc: '',
		AvatarItemType: 0,
		CustomAvatarItemId: item.CustomAvatarItemId,
		CurrencyType: 0,
		Currency: 0,
		Xp: 0,
		PackageType: 0,
		Message: message,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		GiftRarity: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
}

/**
 * Push a GiftPackageReceivedImmediate notification for a gift box the player didn't ask
 * for, mirroring the reference's
 * `HubSendToPlayer(accountID, NotifFrame(GiftPackageReceivedImmediate, {...}))` — the
 * client pops the "you got something" panel from it instead of waiting for the next read of
 * `GET /api/avatar/v2/gifts`.
 *
 * The payload is the reference's field-for-field: the stored box's contents plus its `Id`,
 * a `FromGiftDropId` of 0 (the reference never populates it either) and the
 * platform/balance constants. `Xp` is the drop's, so a game reward's box announces the XP it
 * paid; `Level` is 0, since nothing levels a player up yet.
 *
 * "Immediate" (31) rather than GiftPackageReceived (30) is what the reference sends for a
 * box handed over by the server: a purchase gifted to another player, an admin token grant,
 * a report reward. This is the same case — the player is being handed a box they never
 * clicked for. Best-effort: a hub failure is logged and swallowed, since the gift itself is
 * already granted and stored.
 */
async function pushGiftReceived(
	c: Context<App>,
	accountId: number,
	gift: GrantedGift,
	message: string,
	fromPlayerId: number,
	giftContext: number | null = null
): Promise<void> {
	await sendGiftReceivedFrame(c, accountId, {
		Id: gift.id,
		FromGiftDropId: 0,
		FromPlayerId: fromPlayerId,
		ConsumableItemDesc: gift.drop.ConsumableItemDesc,
		AvatarItemDesc: gift.drop.AvatarItemDesc,
		AvatarItemType: boxAvatarItemType(gift.drop),
		EquipmentPrefabName: gift.drop.EquipmentPrefabName,
		EquipmentModificationGuid: gift.drop.EquipmentModificationGuid,
		CurrencyType: gift.drop.CurrencyType,
		Currency: gift.drop.Currency,
		Xp: gift.drop.Xp ?? 0,
		Level: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
		GiftContext: giftContext ?? gift.drop.Context,
		GiftRarity: gift.drop.Rarity,
		Message: message,
	})
}

/**
 * {@link pushGiftReceived} for a gifted custom avatar item's box, read off its stored
 * content. The frame carries `CustomAvatarItemId` beside the usual fields: the decoder
 * recovered for this frame names no such member and drops unknown ones silently, so it costs
 * nothing if unread, and it is the only thing on the frame that says what the box holds.
 */
async function pushCustomGiftReceived(
	c: Context<App>,
	accountId: number,
	giftId: number,
	content: GiftContent
): Promise<void> {
	await sendGiftReceivedFrame(c, accountId, {
		Id: giftId,
		FromGiftDropId: 0,
		FromPlayerId: content.FromPlayerId,
		ConsumableItemDesc: content.ConsumableItemDesc,
		AvatarItemDesc: content.AvatarItemDesc,
		AvatarItemType: content.AvatarItemType,
		CustomAvatarItemId: content.CustomAvatarItemId,
		EquipmentPrefabName: content.EquipmentPrefabName,
		EquipmentModificationGuid: content.EquipmentModificationGuid,
		CurrencyType: content.CurrencyType,
		Currency: content.Currency,
		Xp: content.Xp,
		Level: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
		GiftContext: content.GiftContext,
		GiftRarity: content.GiftRarity,
		Message: content.Message,
	})
}

/** Send one GiftPackageReceivedImmediate frame, best-effort (see {@link pushGiftReceived}). */
async function sendGiftReceivedFrame(
	c: Context<App>,
	accountId: number,
	payload: Record<string, unknown> & { Id: number }
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.GiftPackageReceivedImmediate,
			payload
		)
	} catch (err) {
		logger.error('failed to push GiftPackageReceivedImmediate notification', {
			accountId,
			giftId: payload.Id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Push a PlayerProgressionLevelUpdate so the client's level bar moves when XP lands, instead
 * of waiting for its next progression read. `XP` is the progress into the current level (the
 * ladder spends the rest on the level-ups), which is what the bar draws against the
 * `LevelProgressionMaps` the client is served.
 *
 * Best-effort: the XP is already banked, so a hub failure costs a bar animation, not the
 * reward.
 */
async function pushProgressionUpdate(
	c: Context<App>,
	accountId: number,
	progression: Progression
): Promise<void> {
	try {
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayer(
			accountId,
			NotificationType.PlayerProgressionLevelUpdate,
			{ PlayerId: progression.PlayerId, Level: progression.Level, XP: progression.XP }
		)
	} catch (err) {
		logger.error('failed to push PlayerProgressionLevelUpdate notification', {
			accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The catalog a query drop rolls from: sf3, the general store. It is the only catalog with
 * a real pool at every rarity (1161 items against 8–40 in the themed ones), it's where the
 * "Random box" family itself sells, and a box promising "a random 4-star item" plainly
 * means the whole item universe rather than whichever seasonal shelf it was bought from.
 */
const ROLL_STOREFRONT_TYPE = 3

/**
 * Every item a roll or a weekly gift may draw, or `[]` if it can't be read (a roll then yields
 * nothing).
 *
 * The storefront PLUS every equipment skin the storefront does not sell. The 2025 store lists
 * every skin (`runx storefront build` appends the ones the game's own store never sold), the
 * 2023 store none — and the weekly gift pool is exactly the equipment in this list, which for
 * an older build would otherwise be empty. The rest come from the `catalog` table, which is
 * loaded from the 2025 store; one already listed is not added again, or a roll would weight it
 * double.
 *
 * Being in this list does NOT make an item purchasable. `findStoreItem` and the bulk bag resolve
 * a purchase against the storefront file, never against this.
 */
async function loadRollCatalog(c: Context<App>): Promise<StoreItem[]> {
	const storefront = await loadStorefront(c, ROLL_STOREFRONT_TYPE)
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM catalog WHERE kind = ?1 AND catalog_id IS NOT NULL`
	)
		.bind(CatalogKind.Skin)
		.all<CatalogRow>()
	const listed = storefront?.StoreItems ?? []
	const sold = new Set(listed.map((item) => item.GiftDrop.EquipmentModificationGuid))
	return [...listed, ...results.filter((row) => !sold.has(row.item_key)).map(toSkinStoreItem)]
}

/**
 * One catalog skin as a STORE ITEM, so the roll catalog and the weekly gift pool can read it the
 * same way they read a storefront entry.
 *
 * Keyed the way a gift-drop keys equipment (`EquipmentPrefabName` + `EquipmentModificationGuid`)
 * rather than as an avatar item — that guid is what marks an entry as equipment, and what the
 * gift pool filters on. Priced at zero: nothing sells these, and a price here would be a number
 * no surface ever shows.
 */
function toSkinStoreItem(row: CatalogRow): StoreItem {
	return {
		GiftDrop: {
			FriendlyName: row.friendly_name,
			Tooltip: row.tooltip ?? '',
			ConsumableItemDesc: '',
			AvatarItemDesc: '',
			// A skin is no avatar item: null, as the store lists every skin.
			AvatarItemType: null,
			EquipmentPrefabName: row.prefab_name ?? '',
			EquipmentModificationGuid: row.item_key,
			Rarity: row.rarity,
			Context: 0,
			Currency: 0,
			CurrencyType: 0,
		},
		Prices: [],
		PurchasableItemId: row.catalog_id as number,
	}
}

/**
 * Equipment prefabs a weekly gift is never drawn from, matched on the prefix of
 * `EquipmentPrefabName`.
 *
 * `[Sandbox_D4]` … `[Sandbox_D20]` are the sandbox dice — 24 skins across six prefabs, a sixth
 * of the whole pool. Theming a week on "Sandbox D8 (Pewter)" spends the week's headline reward
 * on a die recolour, so they are excluded and the pool is the 248 that remain.
 */
const WEEKLY_GIFT_EXCLUDED_PREFABS = ['[Sandbox_']

/**
 * The equipment a weekly challenge gift can be drawn from: every roll-catalog item carrying an
 * `EquipmentModificationGuid`, less {@link WEEKLY_GIFT_EXCLUDED_PREFABS}. Weekly rewards are
 * equipment — the captured rotation's is a camera skin — and that guid is exactly what marks an
 * entry as equipment.
 *
 * The pool is the roll catalog's equipment — the skins the caller's store sells plus the
 * catalog's, see {@link loadRollCatalog} — so a week can be themed on a skin the 2023 store
 * never sold.
 *
 * `GiftDropId` comes off `PurchasableItemId`, which is a skin's `catalog_id` as well.
 */
function toEquipmentGiftPool(catalog: StoreItem[]): EquipmentGift[] {
	return catalog
		.filter(
			(item) =>
				item.GiftDrop.EquipmentModificationGuid !== '' &&
				!WEEKLY_GIFT_EXCLUDED_PREFABS.some((prefix) =>
					item.GiftDrop.EquipmentPrefabName.startsWith(prefix)
				)
		)
		.map((item) => ({
			GiftDropId: item.PurchasableItemId,
			EquipmentPrefabName: item.GiftDrop.EquipmentPrefabName,
			EquipmentModificationGuid: item.GiftDrop.EquipmentModificationGuid,
			Rarity: item.GiftDrop.Rarity,
			// Carried so the rotation can theme the week on the item it rolled; the grant path
			// resolves the same name from this entry when it hands the item over.
			FriendlyName: item.GiftDrop.FriendlyName,
		}))
}

/**
 * The same pool, memoised for the life of the isolate. `getCurrent` needs it on every call
 * just to show the week's reward, and sf3 is a megabyte and a half of JSON to fetch and parse
 * — but it is a bundled asset, so it cannot change under a running isolate and a deploy
 * builds new ones. A failed read is deliberately NOT cached: it would pin an empty pool (and
 * so the static fallback gift) until the next deploy.
 */
let cachedGiftPool: EquipmentGift[] | null = null
async function loadEquipmentGiftPool(c: Context<App>): Promise<EquipmentGift[]> {
	if (cachedGiftPool !== null) return cachedGiftPool
	const pool = toEquipmentGiftPool(await loadRollCatalog(c))
	if (pool.length > 0) cachedGiftPool = pool
	return pool
}

/**
 * Whether the player already owns what a drop carries — the question a query drop's "an
 * item that you don't have" turns on, and the one that decides whether the weekly gift
 * hands over its item or rolls the fallback box instead.
 *
 * Ownership is boolean for avatar items and equipment, which is what makes "already have
 * it" meaningful. A drop carrying neither (a consumable, a currency drop, an empty query
 * box) counts as owned: there is nothing ownable to hand over, so callers offering a
 * fallback should take it.
 */
async function ownsGiftDrop(
	db: D1Database,
	accountId: number,
	giftDrop: StoreGiftDrop
): Promise<boolean> {
	if (typeof giftDrop.AvatarItemDesc === 'string' && giftDrop.AvatarItemDesc !== '') {
		const owned = await getInventory(db, accountId)
		return owned.some((item) => item.AvatarItemDesc === giftDrop.AvatarItemDesc)
	}
	if (
		typeof giftDrop.EquipmentModificationGuid === 'string' &&
		giftDrop.EquipmentModificationGuid !== ''
	) {
		const owned = await getEquipment(db, accountId)
		return owned.some((eq) => eq.ModificationGuid === giftDrop.EquipmentModificationGuid)
	}
	return true
}

/** How a query drop is rolled — what it may land on, and whose catalog copy to use. */
interface RollOptions {
	/**
	 * Restrict the roll to avatar items, leaving equipment skins out of the pool. Off by
	 * default: a bought box says "a random item", and the catalog's own boxes mean both.
	 */
	avatarItemsOnly?: boolean
	/**
	 * The roll catalog, when the caller has already read it — it's the big one (sf3), and a
	 * caller granting several boxes at once shouldn't re-read it per box.
	 */
	rollCatalog?: StoreItem[]
}

/**
 * Roll a query drop: pick, uniformly at random, one item of `rarity` from the roll catalog
 * that the player doesn't already own. Returns null when the pool is empty — an unreadable
 * catalog, a rarity nothing is published at, or a player who owns every item of that tier.
 *
 * The pool is deliberately narrow. Other query drops are excluded (a box that rolls a box
 * would either loop or hand over an unopenable one), and so is everything that isn't an
 * avatar item or a piece of equipment: "an item you don't have" only means anything for
 * things owned once, and consumables stack, so a consumable would be rollable forever and
 * would crowd out the real prizes.
 *
 * `avatarItemsOnly` narrows it further to things worn on the avatar, leaving equipment
 * skins out — a level-up prize should be something the player can see on themselves, not a
 * skin for a weapon they may not own. It also skips the equipment read entirely, since
 * nothing in the pool can match it.
 */
async function rollQueryDrop(
	c: Context<App>,
	accountId: number,
	rarity: number,
	options: RollOptions = {}
): Promise<StoreGiftDrop | null> {
	const [catalog, ownedItems, ownedEquipment] = await Promise.all([
		options.rollCatalog ?? loadRollCatalog(c),
		getInventory(c.env.DB, accountId),
		options.avatarItemsOnly === true ? [] : getEquipment(c.env.DB, accountId),
	])
	const haveItem = new Set(ownedItems.map((item) => item.AvatarItemDesc))
	const haveEquipment = new Set(ownedEquipment.map((eq) => eq.ModificationGuid))
	const pool = catalog.filter(({ GiftDrop: drop }) => {
		if (drop.IsQuery === true || drop.Rarity !== rarity) return false
		if (typeof drop.AvatarItemDesc === 'string' && drop.AvatarItemDesc !== '') {
			return !haveItem.has(drop.AvatarItemDesc)
		}
		if (options.avatarItemsOnly === true) return false
		if (
			typeof drop.EquipmentModificationGuid === 'string' &&
			drop.EquipmentModificationGuid !== ''
		) {
			return !haveEquipment.has(drop.EquipmentModificationGuid)
		}
		return false
	})
	const rolled = pool[Math.floor(Math.random() * pool.length)]
	return rolled?.GiftDrop ?? null
}

/**
 * A gift box that was just created, and the drop it ended up holding. The drop is the
 * RESOLVED one — what a query drop rolled, not the box that promised it — so a caller
 * announcing the gift names the item the player actually won.
 *
 * `id` is 0 when no box was created (`skipGiftBox`) — the drop was still granted.
 */
interface GrantedGift {
	id: number
	drop: StoreGiftDrop
}

/** How a drop is handed over: how a query one rolls, plus how it is wrapped. */
interface GrantOptions extends RollOptions {
	/**
	 * How many of the drop to hand over in ONE box — a bulk line's `DuplicateItemCount`.
	 * Only a consumable stacks, so this multiplies the consumable count and nothing else;
	 * callers must refuse a count above 1 for anything owned once. Defaults to 1.
	 */
	copies?: number
	/**
	 * Grant the drop without creating the gift box that renders it — what a bulk purchase's
	 * `BypassGiftPackages` asks for. Ownership never depended on the box (it is granted here,
	 * not when the box is opened), so this only skips the "open it" moment; a caller setting
	 * it is saying its own UI announces the items.
	 */
	skipGiftBox?: boolean
	/**
	 * Who the box says it is from, and why it exists — a purchase gifted to another player
	 * carries the buyer (or Coach, when they sent it anonymously) and the `Gift` block's
	 * `GiftContext`. Default: Coach and the drop's own context, i.e. a box from the server.
	 */
	fromPlayerId?: number
	giftContext?: number | null
}

/**
 * Pick a random consumable from the roll catalog — the reward the published level table
 * hands out for the early levels.
 *
 * Unlike a clothing roll this one has no rarity and no ownership filter: the table names no
 * star tier for a consumable, and consumables STACK, so "one you don't have" is meaningless
 * (a second Confetti Cannon is a fine prize). Returns a concrete drop rather than a query
 * one, so the grant path just grants it.
 */
function rollConsumableDrop(catalog: StoreItem[]): StoreGiftDrop | null {
	const pool = catalog.filter(
		({ GiftDrop: drop }) =>
			drop.IsQuery !== true &&
			typeof drop.ConsumableItemDesc === 'string' &&
			drop.ConsumableItemDesc !== ''
	)
	return pool[Math.floor(Math.random() * pool.length)]?.GiftDrop ?? null
}

/**
 * Hand a gift-drop to a player: grant whatever it turns out to carry (an avatar item, an
 * equipment skin, a consumable, or none of these — currency/xp drops aren't granted yet)
 * and create the gift box that renders it.
 *
 * A query drop is ROLLED here first, so what gets granted — and what the box shows — is the
 * item the player actually won, not the box that promised it. A roll with nothing left to
 * give falls through with the box itself, which grants nothing: no worse than not rolling,
 * and the warning says which rarity ran dry.
 *
 * Both faucets share this — a storefront purchase and the weekly-challenge reward — so a
 * drop lands in a player's inventory the same way whichever one it came from. The item is
 * granted here, not when the box is opened: consuming a box only deletes the row.
 */
async function grantGiftDrop(
	c: Context<App>,
	accountId: number,
	drop: StoreGiftDrop,
	message: string,
	options: GrantOptions = {}
): Promise<GrantedGift> {
	let giftDrop = drop
	if (drop.IsQuery === true) {
		const rarity = drop.QueryRedirectRarity ?? drop.Rarity
		const rolled = await rollQueryDrop(c, accountId, rarity, options)
		if (rolled === null) {
			logger.warn('query gift-drop rolled nothing', {
				accountId,
				rarity,
				friendlyName: drop.FriendlyName,
			})
		} else {
			giftDrop = rolled
		}
	}
	const db = c.env.DB
	if (typeof giftDrop.AvatarItemDesc === 'string' && giftDrop.AvatarItemDesc !== '') {
		await grantItem(db, accountId, toAvatarItem(giftDrop))
	}
	if (
		typeof giftDrop.EquipmentModificationGuid === 'string' &&
		giftDrop.EquipmentModificationGuid !== ''
	) {
		await grantEquipment(db, accountId, toEquipment(giftDrop))
	}
	// A first-party custom avatar item: the 2025 store lists five hundred of them, each a plain
	// numbered listing whose drop names the item by guid. Ownership is the same row a bag's
	// guid-keyed line writes; without this the line charges and the box opens on nothing.
	if (typeof giftDrop.CustomAvatarItemId === 'string' && giftDrop.CustomAvatarItemId !== '') {
		await grantCustomAvatarItem(db, accountId, giftDrop.CustomAvatarItemId)
	}
	const isConsumable =
		typeof giftDrop.ConsumableItemDesc === 'string' && giftDrop.ConsumableItemDesc !== ''
	const consumableCount = isConsumable ? CONSUMABLE_GRANT_COUNT * (options.copies ?? 1) : 0
	// Capture the granted consumable's row id and the player's pre-existing count so the
	// gift box can carry them — gift-consume fires ConsumableMappingAdded from these.
	let consumableMappingId = 0
	let consumablePreExisting = 0
	if (isConsumable) {
		consumablePreExisting = await countConsumable(db, accountId, giftDrop.ConsumableItemDesc)
		consumableMappingId = await grantConsumable(
			db,
			accountId,
			giftDrop.ConsumableItemDesc,
			consumableCount
		)
	}
	if (options.skipGiftBox === true) {
		// No box means nothing will ever be opened to announce the consumable, so announce it
		// now — otherwise a bag bought with `BypassGiftPackages` doesn't show it until a refetch.
		if (isConsumable) {
			await pushConsumableMappingAdded(c, accountId, {
				mappingId: consumableMappingId,
				consumableItemDesc: giftDrop.ConsumableItemDesc,
				count: consumableCount,
				preExistingCount: consumablePreExisting,
			})
		}
		return { id: 0, drop: giftDrop }
	}
	const { id } = await createGift(
		db,
		accountId,
		toGiftContent(
			giftDrop,
			message,
			consumableCount,
			consumableMappingId,
			consumablePreExisting,
			options.fromPlayerId,
			options.giftContext
		)
	)
	return { id, drop: giftDrop }
}

/**
 * One `BalanceUpdates[].Data` entry: the gift-drop a player RECEIVED, as both purchase
 * endpoints report it. `granted.drop` is the resolved drop — the rolled prize for a query
 * box, not the box that promised it — or a query purchase answers with every item field
 * empty and the client draws an empty box.
 *
 * It carries no FriendlyName or consumable count (the count is a getUnlocked concept; each
 * box is one instance). `giftContext` is the requesting `Gift` block's, when it named one;
 * otherwise the drop's own.
 */
function toBalanceUpdateData(
	granted: GrantedGift,
	fromPlayerId: number,
	message: string,
	giftContext: number | null
): Record<string, unknown> {
	const drop = granted.drop
	return {
		Id: granted.id,
		FromPlayerId: fromPlayerId,
		ConsumableItemDesc: drop.ConsumableItemDesc,
		AvatarItemDesc: drop.AvatarItemDesc,
		AvatarItemType: boxAvatarItemType(drop),
		EquipmentPrefabName: drop.EquipmentPrefabName,
		EquipmentModificationGuid: drop.EquipmentModificationGuid,
		CurrencyType: drop.CurrencyType,
		Currency: drop.Currency,
		Xp: drop.Xp ?? 0,
		Level: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
		GiftContext: giftContext ?? drop.Context,
		GiftRarity: drop.Rarity,
		Message: message,
	}
}

/**
 * `Econ.BulkPurchaseCap` — the most copies one bulk purchase may carry. The client reads
 * the same 200 out of its game config (apps/api/static/gameconfigs-v1-all.json) and caps
 * the bag with it, so this is the server side of a limit the client already knows; a
 * request over it is a client that ignored its own config, not a bigger shopping trip.
 */
const BULK_PURCHASE_CAP = 200

/**
 * `UpdateResponse` — the outcome of ONE `BalanceUpdates` entry, from the client's own enum.
 * This is where a bulk purchase reports per line: the bag answers one entry per REQUESTED
 * item, and `AllowPartialSuccess` is what lets some of them come back non-OK while the
 * envelope's `Success` stays true. (buyItem's single `UpdateResponse: 0` is this same OK.)
 *
 * The members this server can produce are the ones a catalog purchase can fail on;
 * `TooManyRequests`, `PlayerNotEligible`, `RequestCannotBeRefunded` and `PlayerNotApproved`
 * belong to rate limiting, entitlements and refunds, none of which exist here. `AlreadyOwned`
 * is deliberately unused too: buyItem lets a player re-buy an item they own (the grant
 * upserts), and one purchase path refusing what the other allows would be worse than either.
 */
const UpdateResponse = {
	OK: 0,
	TooManyRequests: 1,
	NotEnoughCredit: 2,
	AlreadyOwned: 3,
	NoItemAvailable: 4,
	CouponNotApplicable: 5,
	RequestedPriceDoesNotMatch: 6,
	RequestedAmountNotAllowed: 7,
	PlayerNotEligible: 8,
	RequestCannotBeRefunded: 9,
	PlayerNotApproved: 10,
} as const

/** The discriminated item id a bulk-purchase line names its item by. */
interface PurchaseMethodId {
	Type: number
	NumberId: number | null
	Guid: string | null
}

/** One line of a `POST /api/items/bulkpurchase` body. */
interface PurchaseItemRequest {
	ItemPurchaseMethodId?: Partial<PurchaseMethodId> | null
	RequestedPrice?: number
	Gift?: GiftRequest | null
	CouponConsumablePlayerMappingId?: number | null
	DuplicateItemCount?: number
}

/**
 * A line that could not be bought: the `UpdateResponse` its entry carries, and the message
 * that fills the envelope's single `Error` when the bag as a whole is refused.
 */
interface BulkLineFailure {
	method: PurchaseMethodId
	code: number
	error: string
}

/** A line that resolved to a catalog item, with the catalog's own price. */
interface BulkCatalogLine {
	kind: 'catalog'
	method: PurchaseMethodId
	item: StoreItem
	/** The UNIT price from the catalog — `count` copies cost `price * count`. */
	price: number
	count: number
	gift: GiftRequest | null
}

/**
 * A line that resolved to a CUSTOM avatar item — a guid-keyed line, the `Guid` being the
 * item's `CustomAvatarItemId` — at the item's own `Price`. Owned once, so `count` is one; the
 * price goes to the item's creator rather than nowhere, which is what makes it a sale.
 */
interface BulkCustomLine {
	kind: 'custom'
	method: PurchaseMethodId
	custom: CustomAvatarItem
	price: number
	count: 1
	gift: GiftRequest | null
}

/** A line that resolved to something buyable. */
type BulkPurchaseLine = BulkCatalogLine | BulkCustomLine

/**
 * One `BalanceUpdates[].Data` — what a single requested item turned into. Unlike buyItem's,
 * it NAMES the purchase rather than describing the drop: the client already has the catalog
 * entry for `PurchasableItemId`, so the only thing it can't reconstruct is the box.
 *
 * `CustomAvatarItem` is the UGC counterpart of `PurchasableItemId`: the whole item record on
 * a guid-keyed line that sold, which the client has nothing else to render it from. Both it
 * and `GiftPackage` are null on a line that didn't sell. A custom item's box names it by
 * `CustomAvatarItemId` rather than `AvatarItemDesc`; ownership is granted straight into
 * `inventory_custom` either way.
 */
interface BulkPurchaseData {
	GiftPackage: Record<string, unknown> | null
	PurchasableItemId: number | null
	CustomAvatarItem: CustomAvatarItem | null
}

/** `ItemPurchaseMethodId.Type` for a numeric (storefront `PurchasableItemId`) id. */
const PURCHASE_METHOD_NUMBER_ID = 0

/**
 * The gift box as `GiftPackage` carries it — the same DTO family as buyItem's
 * `BalanceUpdates[].Data` entry, but with the four keys that shape doesn't carry
 * (`PlayerId`, `CustomAvatarItemId`, `Signature`, `IsSignatureValid`) and without its
 * `Level`. Twenty keys, in the order the client's own member list names them.
 *
 * `Platform`/`PlatformsToSpawnOn` are the platform MASK (-1, all) — the balance bucket is
 * the separate `BalanceType` beside them, unlike the envelope's `Value.Platform`, which IS
 * a renamed `BalanceType`. `Signature` is null and `IsSignatureValid` false: a box the
 * server minted was never signed for peer-to-peer transfer.
 */
function toGiftPackage(
	granted: GrantedGift,
	playerId: number,
	fromPlayerId: number,
	message: string,
	giftContext: number | null
): Record<string, unknown> {
	const drop = granted.drop
	return {
		Id: granted.id,
		PlayerId: playerId,
		FromPlayerId: fromPlayerId,
		ConsumableItemDesc: drop.ConsumableItemDesc,
		AvatarItemType: boxAvatarItemType(drop),
		AvatarItemDesc: drop.AvatarItemDesc,
		CustomAvatarItemId: null,
		EquipmentPrefabName: drop.EquipmentPrefabName,
		EquipmentModificationGuid: drop.EquipmentModificationGuid,
		CurrencyType: drop.CurrencyType,
		Currency: drop.Currency,
		Xp: drop.Xp ?? 0,
		GiftContext: giftContext ?? drop.Context,
		GiftRarity: drop.Rarity,
		Message: message,
		Signature: null,
		IsSignatureValid: false,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
	}
}

/**
 * {@link toGiftPackage} for the box a custom avatar item comes in — the same twenty keys,
 * read off the stored {@link toCustomGiftContent} so the response and `GET
 * /api/avatar/v2/gifts` describe one box.
 */
function toCustomGiftPackage(
	id: number,
	playerId: number,
	content: GiftContent
): Record<string, unknown> {
	return {
		Id: id,
		PlayerId: playerId,
		FromPlayerId: content.FromPlayerId,
		ConsumableItemDesc: content.ConsumableItemDesc,
		AvatarItemType: content.AvatarItemType,
		AvatarItemDesc: content.AvatarItemDesc,
		CustomAvatarItemId: content.CustomAvatarItemId,
		EquipmentPrefabName: content.EquipmentPrefabName,
		EquipmentModificationGuid: content.EquipmentModificationGuid,
		CurrencyType: content.CurrencyType,
		Currency: content.Currency,
		Xp: content.Xp,
		GiftContext: content.GiftContext,
		GiftRarity: content.GiftRarity,
		Message: content.Message,
		Signature: null,
		IsSignatureValid: false,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: ALL_PLATFORMS,
	}
}

/**
 * Normalise the id a line named its item by. A line that sent no id at all still resolves
 * to something, so this never returns null — the checks in {@link resolveBulkLine} are what
 * reject it.
 */
function toPurchaseMethodId(raw: Partial<PurchaseMethodId> | null | undefined): PurchaseMethodId {
	const id = typeof raw === 'object' && raw !== null ? raw : {}
	return {
		Type: Number.isInteger(id.Type) ? (id.Type as number) : PURCHASE_METHOD_NUMBER_ID,
		NumberId: Number.isInteger(id.NumberId) ? (id.NumberId as number) : null,
		Guid: typeof id.Guid === 'string' ? id.Guid : null,
	}
}

/**
 * Resolve one line against the bag's catalog: what it wants, how many, and at what price.
 * Returns the failure — with the `UpdateResponse` its entry will carry — instead when the
 * line can't be bought.
 *
 * Pure — the catalog and the buyer's subscriber status are passed in — so the whole bag
 * resolves from ONE storefront read and ONE token read. The price check is buyItem's, per
 * line: `RequestedPrice` is the UNIT price the client rendered (for a subscriber, anywhere in
 * the discount band — see {@link priceCheck}), and a mismatch means the catalog moved under a
 * stale client rather than that the player agreed to today's price.
 */
function resolveBulkLine(
	line: PurchaseItemRequest,
	storefront: Storefront | null,
	currencyType: number,
	subscriber: boolean,
	custom: CustomBagContext
): BulkPurchaseLine | BulkLineFailure {
	const method = toPurchaseMethodId(line.ItemPurchaseMethodId)
	// Nothing issues coupons, so a line claiming one would otherwise be charged full price
	// for a discount it thinks it applied.
	if (
		line.CouponConsumablePlayerMappingId !== null &&
		line.CouponConsumablePlayerMappingId !== undefined
	) {
		return {
			method,
			code: UpdateResponse.CouponNotApplicable,
			error: 'Coupons are not supported',
		}
	}
	const count = line.DuplicateItemCount ?? 1
	if (!Number.isInteger(count) || count < 1) {
		return {
			method,
			code: UpdateResponse.RequestedAmountNotAllowed,
			error: 'DuplicateItemCount must be a positive integer',
		}
	}
	// A guid-keyed line names a CUSTOM avatar item, resolved against the `custom_avatar_item`
	// table rather than the bag's catalog.
	if (method.Type === PURCHASE_METHOD_TYPE_GUID) {
		return resolveCustomLine(line, method, count, currencyType, custom)
	}
	if (method.Type !== PURCHASE_METHOD_NUMBER_ID || method.NumberId === null) {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: 'Only storefront item ids and custom avatar item guids can be bought',
		}
	}
	if (storefront === null) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'No such storefront' }
	}
	const item = storefront.StoreItems.find((it) => it.PurchasableItemId === method.NumberId)
	if (item === undefined) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'Item not found' }
	}
	// Une tenue Rec Room Plus ne se vend qu'à un abonné, exactement comme dans buyItem — sans
	// ce refus, un panier serait le chemin pour l'acheter sans Plus.
	if (item.GiftDrop.SubscribersOnly === true && !subscriber) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'Rec Room Plus required' }
	}
	// Only a consumable stacks. An avatar item or an equipment skin is owned once, so a
	// second copy would grant nothing while charging for it — and the bag answers ONE entry
	// (one box) per requested item, which is the same statement from the wire's side.
	if (count > 1 && item.GiftDrop.ConsumableItemDesc === '') {
		return {
			method,
			code: UpdateResponse.RequestedAmountNotAllowed,
			error: 'This item can only be bought once per line',
		}
	}
	const checked = priceCheck(item, currencyType, subscriber, line.RequestedPrice)
	if (checked === 'no-currency') {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: 'Currency type not available for this item',
		}
	}
	if (checked === 'mismatch') {
		return {
			method,
			code: UpdateResponse.RequestedPriceDoesNotMatch,
			error: !Number.isInteger(line.RequestedPrice)
				? 'RequestedPrice is required'
				: 'Price has changed',
		}
	}
	const gift = typeof line.Gift === 'object' && line.Gift !== null ? line.Gift : null
	return { kind: 'catalog', method, item, price: checked.charge, count, gift }
}

/**
 * What a bag's guid-keyed lines resolve against, read ONCE for the bag: the custom avatar
 * items it names (keyed by lowercased id — a GUID's case is not part of its identity, and the
 * client is not consistent about it) and which of them the buyer already owns.
 */
interface CustomBagContext {
	buyerId: number
	items: Map<string, CustomAvatarItem>
	/** Which of the bag's guids each line's RECEIVER already owns, keyed by receiver. */
	owned: Map<number, Set<string>>
}

/** Who a bag line's item goes to: the `Gift` block's `ToPlayerId`, else the buyer. */
function lineReceiver(gift: GiftRequest | null | undefined, buyerId: number): number {
	return Number.isInteger(gift?.ToPlayerId) ? (gift?.ToPlayerId as number) : buyerId
}

/**
 * Resolve a guid-keyed line to the custom avatar item it names, or the failure its entry will
 * carry. The rules are buyInvention's, per line, applied to whoever RECEIVES the item — the
 * buyer, or the player a `Gift` block names: the item must exist and be published
 * (`Accessibility` 0 is a draft, visible to its creator alone), the receiver must not be its
 * creator (who owns it already — and, buying it themself, would be paying themself) nor own
 * it already, and the
 * posted `RequestedPrice` must be the item's `Price` — no subscriber band, since a custom
 * item has no `SubscriberPrices`. Custom items are priced in RecCenterTokens only, as the
 * store lists them, so a bag in another currency cannot buy one. Owned once, so a count above
 * one is refused as it is for an avatar item. A creator may GIFT their own item: they pay the
 * price and are paid it back, so the receiver gets it at no net cost to anyone.
 */
function resolveCustomLine(
	line: PurchaseItemRequest,
	method: PurchaseMethodId,
	count: number,
	currencyType: number,
	custom: CustomBagContext
): BulkCustomLine | BulkLineFailure {
	const guid = method.Guid?.toLowerCase() ?? null
	const item = guid === null ? undefined : custom.items.get(guid)
	if (guid === null || item === undefined || item.Accessibility === 0) {
		return { method, code: UpdateResponse.NoItemAvailable, error: 'Item not found' }
	}
	const gift = typeof line.Gift === 'object' && line.Gift !== null ? line.Gift : null
	const receiverId = lineReceiver(gift, custom.buyerId)
	if (item.CreatorAccountId === receiverId) {
		return {
			method,
			code: UpdateResponse.PlayerNotEligible,
			error:
				receiverId === custom.buyerId
					? 'Cannot buy your own item'
					: 'The recipient created this item',
		}
	}
	if (custom.owned.get(receiverId)?.has(guid) === true) {
		return { method, code: UpdateResponse.AlreadyOwned, error: 'Already owned' }
	}
	// A ticket reward (a non-token `PurchaseCurrencyType`, set by the load from the storefronts)
	// is earned and bought in its own game's store, never here: the token store doesn't list it.
	if (
		(item.PurchaseCurrencyType ?? CurrencyType.RecCenterTokens) !== CurrencyType.RecCenterTokens
	) {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: "This item is earned in its game's store, not sold for tokens",
		}
	}
	if (currencyType !== CurrencyType.RecCenterTokens) {
		return {
			method,
			code: UpdateResponse.NoItemAvailable,
			error: 'Currency type not available for this item',
		}
	}
	if (count !== 1) {
		return {
			method,
			code: UpdateResponse.RequestedAmountNotAllowed,
			error: 'This item can only be bought once per line',
		}
	}
	if (line.RequestedPrice !== item.Price) {
		return {
			method,
			code: UpdateResponse.RequestedPriceDoesNotMatch,
			error: !Number.isInteger(line.RequestedPrice)
				? 'RequestedPrice is required'
				: 'Price has changed',
		}
	}
	return { kind: 'custom', method, custom: item, price: item.Price, count: 1, gift }
}

/** Whether a resolved line is buyable or is already a failure. */
function isBulkLine(resolved: BulkPurchaseLine | BulkLineFailure): resolved is BulkPurchaseLine {
	return 'kind' in resolved
}

/**
 * XP paid for a claimed game reward. One flat amount for every reward type — "First Game of
 * the Day" and "Activity completed!" are the same size of pat on the back until there's
 * reason to price them apart.
 *
 * Exactly what each of the first three levels costs, so a fresh player's first rewards each
 * level them up; from level 4 (20 XP a level) it takes two or more. The daily
 * {@link GAME_REWARD_DAILY_XP_CAP} paces it from there.
 */
const GAME_REWARD_XP = 10

/**
 * The most game-reward XP a player earns in one rolling 24h window: fifteen claims' worth,
 * whatever the type or activity — `FirstActivityOfDay` aside, whose XP is a bonus on top, like
 * its tokens. The running total is the player's `$xp` row in `reward_status`
 * (`claimAllowance`). A multiple of {@link GAME_REWARD_XP} — a claim that would cross it pays
 * no XP.
 */
const GAME_REWARD_DAILY_XP_CAP = 150

/**
 * `GiftContext.GameRewards` — what the box says it came from, so the client files it under
 * gameplay rewards rather than a purchase or a player's gift. (`51` is the tokens variant,
 * for when a reward pays currency instead of XP.)
 */
const GIFT_CONTEXT_GAME_REWARDS = 50

/** Shown on the box when the client asks for a reward without saying what to call it. */
const DEFAULT_GAME_REWARD_MESSAGE = 'Reward earned!'

/**
 * Tokens paid with each claimed {@link TOKEN_REWARD_TYPES} reward, until the player has had
 * {@link GAME_REWARD_DAILY_TOKEN_CAP} in the current 24h window — whatever the activity.
 * The running total is the player's `$tokens` row in `reward_status` (`claimAllowance`).
 */
const GAME_REWARD_TOKENS = 250

/**
 * The most game-reward tokens a player earns in one rolling 24h window: five claims' worth.
 * A multiple of {@link GAME_REWARD_TOKENS} — a claim that would cross it pays nothing.
 */
const GAME_REWARD_DAILY_TOKEN_CAP = 1250

/**
 * The reward types whose tokens draw on the daily allowance: the client's ask after a match
 * and after a quest. {@link FIRST_ACTIVITY_OF_DAY} pays its own on top, outside the cap.
 */
const TOKEN_REWARD_TYPES = new Set(['PostGameActivity', 'PostQuestActivity'])

/**
 * The once-a-day bonus. Its claim is per PLAYER — keyed on the empty context whatever
 * activity asked — on a 24h cooldown, and it pays {@link GAME_REWARD_TOKENS} outside the
 * daily cap: the claim itself is what limits it, so it needs no allowance row.
 */
const FIRST_ACTIVITY_OF_DAY = 'FirstActivityOfDay'

/**
 * `GiftContext.GameRewardsTokens` — the tokens variant of {@link GIFT_CONTEXT_GAME_REWARDS},
 * on the box the token payout arrives in.
 */
const GIFT_CONTEXT_GAME_REWARDS_TOKENS = 51

/** The message on the token payout's box. */
const GAME_REWARD_TOKENS_MESSAGE = 'Activity bonus!'

/**
 * The gift-drop a claimed game reward's token payout hands over: tokens in a box, no item, no XP. Like
 * {@link toGameRewardDrop}, `grantGiftDrop` creates only the box from it — the tokens are
 * credited to the balance separately, and the copy here is what the box displays.
 */
function toGameRewardTokensDrop(): StoreGiftDrop {
	return {
		FriendlyName: '',
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: 0,
		Context: GIFT_CONTEXT_GAME_REWARDS_TOKENS,
		Currency: GAME_REWARD_TOKENS,
		CurrencyType: CurrencyType.RecCenterTokens,
		Xp: 0,
	}
}

/**
 * The gift-drop a claimed game reward hands over: XP in a box, no item. Every item field is
 * empty on purpose — this is not a purchase and not a roll, so `grantGiftDrop` grants
 * nothing into the inventory and only creates the box. The XP is banked in `progression`;
 * the copy here is what the box and its notification display.
 */
function toGameRewardDrop(xp: number): StoreGiftDrop {
	return {
		FriendlyName: '',
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: 0,
		Context: GIFT_CONTEXT_GAME_REWARDS,
		Currency: 0,
		CurrencyType: 0,
		Xp: xp,
	}
}

/**
 * One row of `static/quest-rewards.json`: the reward table of the live game's activities,
 * keyed by the `giftContext` the client posts with a game-reward ask (`Dodgeball`,
 * `Quest_Goblin_S`, `Paintball_Dam`, …). Each row is the gift-drop as the game's own reward
 * server shaped it — a comma-laden `AvatarItemDesc` (the catalog's `item_key`), or for the
 * Laser Tag entry a currency payout — with `GiftRarity` and the activity's own `Context`
 * (8000 for dodgeball, 4003 for the goblin quest's S rank) spelled the way the client's box
 * reads them. Untyped fields (`Id`, `Level`, `Message`) are carried but unused.
 */
interface QuestReward {
	AvatarItemDesc: string
	ConsumableItemDesc: string
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	CurrencyType: number
	Currency: number
	Xp: number
	GiftRarity: number
	Context: number
}

const QUEST_REWARDS: Record<string, QuestReward[]> = questRewards

/**
 * The reward an activity pays, when `giftContext` names an entry in `quest-rewards.json`:
 * one row drawn at random from that key's list, among the rows the player DOESN'T ALREADY
 * OWN — the table is "what this activity can give you", and handing over a duplicate gives
 * nothing (the inventory is a set). A currency row is never "owned", so it always stays in
 * the pool.
 *
 * Null for a context the table doesn't know (or one whose every reward the player already
 * has), which the caller pays as the plain XP box — the cooldown key is the same string
 * either way, so an unknown or exhausted context is still rate-limited.
 */
async function pickQuestReward(
	db: D1Database,
	accountId: number,
	giftContext: string
): Promise<QuestReward | null> {
	if (!Object.hasOwn(QUEST_REWARDS, giftContext)) return null
	const rows = QUEST_REWARDS[giftContext] ?? []
	if (rows.length === 0) return null
	const ownedItems = new Set((await getInventory(db, accountId)).map((i) => i.AvatarItemDesc))
	const ownedGuids = new Set((await getEquipment(db, accountId)).map((e) => e.ModificationGuid))
	const pool = rows.filter(
		(r) =>
			!(r.AvatarItemDesc !== '' && ownedItems.has(r.AvatarItemDesc)) &&
			!(r.EquipmentModificationGuid !== '' && ownedGuids.has(r.EquipmentModificationGuid))
	)
	if (pool.length === 0) {
		logger.info('quest rewards exhausted for player', { accountId, giftContext })
		return null
	}
	return pool[Math.floor(Math.random() * pool.length)] ?? null
}

/**
 * A quest reward as the gift-drop `grantGiftDrop` hands over. The item fields come off the
 * row, so the item IS granted — unlike {@link toGameRewardDrop}'s empty box. The catalog
 * row for the item, when it resolves, supplies what the table doesn't carry (name, tooltip,
 * `AvatarItemType`), so the inventory entry reads like a bought one rather than blank.
 * The XP is the game reward's (`xp`), not the row's (always 0): the reward is the item, and
 * the XP is the same pat on the back every claim gets while the daily cap has room.
 */
function toQuestRewardDrop(
	reward: QuestReward,
	catalog: CatalogRow | null,
	xp: number
): StoreGiftDrop {
	return {
		FriendlyName: catalog?.friendly_name ?? '',
		Tooltip: catalog?.tooltip ?? '',
		ConsumableItemDesc: reward.ConsumableItemDesc,
		AvatarItemDesc: reward.AvatarItemDesc,
		AvatarItemType: catalog?.avatar_item_type ?? null,
		EquipmentPrefabName: reward.EquipmentPrefabName,
		EquipmentModificationGuid: reward.EquipmentModificationGuid,
		Rarity: reward.GiftRarity,
		Context: reward.Context,
		Currency: reward.Currency,
		CurrencyType: reward.CurrencyType,
		Xp: xp,
	}
}

/**
 * The box a CLOTHING level-up hands over: a query drop at the level's own tier, rolled from
 * AVATAR ITEMS only. The published table calls these levels "N-Star Clothing", so the prize
 * has to be something the player can wear and be seen in — never an equipment skin for a
 * weapon they may not own. This is the one roll that narrows the pool that far.
 */
function toLevelUpDrop(rarity: number): StoreGiftDrop {
	return {
		FriendlyName: '',
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: rarity,
		Context: GIFT_CONTEXT_GAME_REWARDS,
		Currency: 0,
		CurrencyType: 0,
		IsQuery: true,
	}
}

/**
 * Hand over the rewards a run of level-ups earned — ONE PER LEVEL crossed, since the
 * published table names a reward for every level and a single grant can cross several (a
 * large enough grant could clear the first three levels at 10 XP each). Each arrives as a
 * gift box, announced like any other unasked-for gift.
 *
 * Which reward is per level, not per tier: the early levels pay CONSUMABLES and the rest pay
 * clothing at a rising star rating. The catalog is read once and shared across the boxes.
 * Every level also PAYS {@link LEVEL_UP_TOKENS} tokens, credited to the balance before the box
 * is created so the box can show them: being levelled is worth the same whatever the item
 * roll does, so a roll that comes up empty still pays.
 *
 * Best-effort as a whole: the XP is banked and the levels are already stored, so a failed
 * roll costs a prize, not the level.
 */
async function grantLevelUpGifts(
	c: Context<App>,
	accountId: number,
	grant: XpGrant
): Promise<void> {
	const levels = levelsReached(grant)
	if (levels.length === 0) return
	try {
		const rollCatalog = await loadRollCatalog(c)
		const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
		for (const level of levels) {
			const reward = levelReward(level)
			if (reward === null) continue
			const message = `Level ${level}!`
			// Les crédits du niveau d'abord : la boîte qui suit les annonce et les montre, donc
			// ils doivent déjà être au solde quand elle est créée.
			await ensureStartingBalances(c.env.DB, accountId, startingTokens)
			const balance = await creditCurrency(
				c.env.DB,
				accountId,
				CurrencyType.RecCenterTokens,
				LEVEL_UP_TOKENS,
				startingTokens
			)
			await pushBalanceUpdate(c, accountId, CurrencyType.RecCenterTokens, balance)
			// A consumable is rolled to a concrete drop up front; clothing rides the query path,
			// which rolls it against what the player already owns.
			const rolled =
				reward.kind === 'consumable'
					? rollConsumableDrop(rollCatalog)
					: toLevelUpDrop(reward.rarity)
			if (rolled === null) {
				logger.warn('level up reward rolled nothing', { accountId, level, kind: reward.kind })
				continue
			}
			// La boîte porte l'item ET les crédits du niveau : une seule boîte par niveau, qui dit
			// tout ce que le niveau a payé.
			const drop: StoreGiftDrop = {
				...rolled,
				Currency: LEVEL_UP_TOKENS,
				CurrencyType: CurrencyType.RecCenterTokens,
			}
			const granted = await grantGiftDrop(c, accountId, drop, message, {
				avatarItemsOnly: reward.kind === 'clothing',
				rollCatalog,
			})
			await pushGiftReceived(c, accountId, granted, message, COACH_ACCOUNT_ID)
			logger.info('level up gift granted', {
				accountId,
				level,
				kind: reward.kind,
				rarity: reward.kind === 'clothing' ? reward.rarity : null,
				giftId: granted.id,
				avatarItemDesc: granted.drop.AvatarItemDesc,
				consumableItemDesc: granted.drop.ConsumableItemDesc,
			})
		}
	} catch (err) {
		logger.error('failed to grant level up gift', {
			accountId,
			levels,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * What reaching a level pays in tokens, on top of the level's item. Credited once per level
 * crossed — a grant that takes a player up three levels pays three times — and shown on the
 * level-up box beside the item.
 */
const LEVEL_UP_TOKENS = 250

/** The message on the gift box the weekly reward arrives in. */
const CHALLENGE_GIFT_MESSAGE = 'Weekly challenge complete!'

/**
 * The star rating → `Rarity` ladder, indexed by stars - 1. Pinned by sf2's "Star Boxes"
 * item set, whose three members name their own tier and carry the rarity they roll at:
 * 2-Star → 10, 3-Star → 20, 4-Star → 30. The ends are extrapolated from sf3's parallel
 * "Random box" family (Common 0, Uncommon 10, Rare 20, Epic 30, Legendary 50), which is the
 * same ladder under the other naming.
 */
const STAR_RARITY = [0, 10, 20, 30, 50]

/** The tier a "4-Star Box" rolls at, used when a rotation's fallback name doesn't parse. */
const DEFAULT_FALLBACK_STARS = 4

/**
 * The rarity the rotation's `FallbackGiftName` promises, read off the leading star count
 * ("4-Star Box" → 30). That string is the whole specification of the consolation prize —
 * it is what the client renders when the gift resolves to a box rather than a named item —
 * so a rotation can retune the tier by renaming it, with no code change.
 */
function fallbackGiftRarity(rotation: WeeklyChallengeRotation): number {
	const stars = Number(/^(\d+)-star/i.exec(rotation.FallbackGiftName)?.[1])
	return STAR_RARITY[stars - 1] ?? STAR_RARITY[DEFAULT_FALLBACK_STARS - 1] ?? 0
}

/**
 * Translate the rotation's `Gift` block into the storefront gift-drop shape the grant path
 * reads. The renamed fields are the whole point — feeding one shape to the other's reader
 * silently drops the rarity and context.
 *
 * The reward carries no price, so `Currency`/`CurrencyType` are zero: the box shows an
 * item, not a payout. Display strings come from the block when it carries them; a block
 * that doesn't (the captured rotation names neither) borrows them from the catalog entry
 * selling the same item, so the granted item reads as itself — "Camera Skin (Comic)" rather
 * than the name of the box it might have arrived in.
 */
function toChallengeGiftDrop(
	rotation: WeeklyChallengeRotation,
	catalog: StoreItem[]
): StoreGiftDrop {
	const gift: ChallengeGiftBlock = rotation.Gift
	const sold = catalog.find(
		({ GiftDrop: drop }) =>
			(gift.EquipmentModificationGuid !== '' &&
				drop.EquipmentModificationGuid === gift.EquipmentModificationGuid) ||
			(gift.AvatarItemDesc !== '' && drop.AvatarItemDesc === gift.AvatarItemDesc)
	)?.GiftDrop
	return {
		FriendlyName: gift.FriendlyName ?? sold?.FriendlyName ?? rotation.FallbackGiftName,
		Tooltip: gift.Tooltip ?? sold?.Tooltip ?? '',
		ConsumableItemDesc: gift.ConsumableItemDesc,
		AvatarItemDesc: gift.AvatarItemDesc,
		AvatarItemType: gift.AvatarItemType,
		EquipmentPrefabName: gift.EquipmentPrefabName,
		EquipmentModificationGuid: gift.EquipmentModificationGuid,
		// The block's own `GiftRarity` is 0 in the captured rotation even though the item it
		// names sells at rarity 5, so the catalog's rarity wins where there is one.
		Rarity: sold?.Rarity ?? gift.GiftRarity,
		Context: gift.GiftContext,
		Currency: 0,
		CurrencyType: 0,
	}
}

/**
 * The consolation box: a query drop at the rarity `FallbackGiftName` promises, named after
 * it. Handed over instead of the rotation's item when that item would be a duplicate, which
 * is what the fallback name is for — the reward reads "the Camera Skin, or a 4-Star Box".
 */
function toChallengeFallbackDrop(rotation: WeeklyChallengeRotation): StoreGiftDrop {
	return {
		FriendlyName: rotation.FallbackGiftName,
		Tooltip: '',
		ConsumableItemDesc: '',
		AvatarItemDesc: '',
		AvatarItemType: null,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		Rarity: fallbackGiftRarity(rotation),
		Context: rotation.Gift.GiftContext,
		Currency: 0,
		CurrencyType: 0,
		IsQuery: true,
	}
}

/**
 * How many of a rotation's challenges earn its gift. A week presents five and asks for
 * three: the reward is for playing most of the week's set, not for clearing all of it, so
 * the two a player can't reach (a quest they don't own, a mode they don't like) don't sink
 * the whole week.
 */
const CHALLENGES_REQUIRED_FOR_GIFT = 3

/**
 * How many completions this rotation's gift needs. `CompletedRequired` makes the set
 * all-or-nothing when it's true — the reading its name and the partial default suggest —
 * and a rotation shorter than the threshold can only ever ask for what it publishes.
 */
function challengesRequiredForGift(rotation: WeeklyChallengeRotation): number {
	const published = rotation.Challenges.length
	return rotation.CompletedRequired ? published : Math.min(CHALLENGES_REQUIRED_FOR_GIFT, published)
}

/**
 * Award the rotation's `Gift` if this player has just earned it, doing nothing otherwise.
 * Called after each completing progress report, since `updateProgress` is the only place a
 * challenge is ever finished — there is no separate claim endpoint, and the client never
 * asks for this reward.
 *
 * Earning it takes {@link challengesRequiredForGift} of the rotation's challenges, counted
 * from `challenge_status`. Only challenges the rotation still publishes count: a report can
 * carry an id this week's set no longer lists (an edited rotation under a live client), and
 * three of those shouldn't buy a gift the player never worked for.
 *
 * What lands is the `Gift` block's item — or, if the player already owns it, the box named
 * by `FallbackGiftName`, which rolls something they don't have at that tier. Finishing the
 * week can't be worth nothing, and the rotation's reward is one fixed item that plenty of
 * players will have bought already.
 *
 * A grant that throws is swallowed: the client is reporting gameplay progress, and failing
 * that report (which it would then retry with the same completion) is worse than missing
 * the reward — the claim row is already taken, so the miss is permanent but visible in the
 * logs. An empty rotation earns nothing: its threshold clamps to zero, which every player
 * would otherwise meet without playing.
 */
async function awardChallengeGift(c: Context<App>, accountId: number): Promise<void> {
	const rotation = buildRotation(new Date())
	try {
		if (rotation.Challenges.length === 0) return
		const statuses = await getChallengeStatuses(c.env.DB, accountId, rotation.ChallengeMapId)
		const done = rotation.Challenges.filter(
			(ch) => statuses.get(ch.ChallengeId)?.complete === true
		).length
		if (done < challengesRequiredForGift(rotation)) return
		// Claim first: this is what stops the next report paying out a second time.
		const claimed = await claimChallengeGift(c.env.DB, accountId, rotation.ChallengeMapId)
		if (!claimed) return
		// Only now is the catalog worth reading: it names the week's reward and is what the
		// grant path rolls a duplicate's replacement from.
		const catalog = await loadRollCatalog(c)
		const week = withWeeklyGift(rotation, toEquipmentGiftPool(catalog))
		const reward = toChallengeGiftDrop(week, catalog)
		const duplicate = await ownsGiftDrop(c.env.DB, accountId, reward)
		const granted = await grantGiftDrop(
			c,
			accountId,
			duplicate ? toChallengeFallbackDrop(week) : reward,
			CHALLENGE_GIFT_MESSAGE,
			{ rollCatalog: catalog }
		)
		// Nobody asked for this box, so the client has no reason to re-read the gifts list:
		// the notification is what makes the reward show up at the moment the set is finished.
		// From "Coach", the same system sender a self-buy is attributed to — the rotation is
		// the server handing something over, not another player.
		await pushGiftReceived(c, accountId, granted, CHALLENGE_GIFT_MESSAGE, COACH_ACCOUNT_ID)
		logger.info('weekly challenge gift granted', {
			accountId,
			challengeMapId: rotation.ChallengeMapId,
			giftId: granted.id,
			fallbackRoll: duplicate,
			challengesComplete: done,
		})
	} catch (err) {
		logger.error('failed to grant weekly challenge gift', {
			accountId,
			challengeMapId: rotation.ChallengeMapId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The default NUX checklist for a brand-new account. `Objective` is an `ObjectiveType`
 * ordinal (from the client's `ProgressionManager`) that the client matches its own
 * progress events against — the names below are what those ordinals mean.
 */
const DEFAULT_CHECKLIST = [
	{ Order: 0, Objective: 38, Count: 1, CreditAmount: 25 }, // SaveOutfitSlot
	{ Order: 1, Objective: 32, Count: 1, CreditAmount: 25 }, // VisitACustomRoom
	{ Order: 2, Objective: 2, Count: 1, CreditAmount: 25 }, // AddAFriend
	{ Order: 3, Objective: 30, Count: 1, CreditAmount: 25 }, // GoToRecCenter
	{ Order: 4, Objective: 6, Count: 1, CreditAmount: 25 }, // CheerAPlayer
]

/** The `UpdateResponse` context a checklist reward is reported under. */
const CHECKLIST_REWARD_CONTEXT = 303

/**
 * A concise `describeRoute` spec for a route that serves an opaque JSON array — either
 * a static catalog served verbatim or an empty-list stub. `auth` adds the bearer
 * requirement + a 401 response.
 */
function listRoute(summary: string, description: string, auth = false) {
	return describeRoute({
		tags: ['Econ'],
		summary,
		description,
		...(auth ? { security: AUTHED } : {}),
		responses: {
			200: json(JsonArray, description),
			...(auth ? { 401: UNAUTHORIZED_RESPONSE } : {}),
		},
	})
}

/**
 * A completed invention purchase: the invention that changed hands and the buyer's
 * RESULTING token balance (not the change — see the envelopes both routes build from it).
 */
interface SettledInventionPurchase {
	invention: SavedInvention
	balance: number
}

/**
 * Settle an invention purchase — the whole of buyInvention except the envelope it is
 * announced in, shared by the `v2` GET and the `v3` POST. Every refusal is a `Response`
 * (the `{ error }` body both routes answer with); a sale is the bought invention and the
 * buyer's resulting balance, which each route then wraps in ITS OWN shape — the two
 * clients want different ones, so the money is shared and the projection is not.
 *
 * A priced invention is settled player-to-player: the buyer is debited its `Price` in
 * RecCenterTokens and the CREATOR is credited the same amount — no house cut, so the
 * tokens are moved rather than minted or burned. A free invention (`Price` 0) skips the
 * money entirely: nothing is debited and nobody is paid. The stored price is confirmed
 * against the price the client rendered first, so a stale or tampered client can’t buy
 * at a price the creator no longer offers (409), and an unaffordable one is a 400 —
 * the same "Insufficient balance" buyItem answers with.
 *
 * Ownership is recorded in `inventory_invention`; the creator is not sold their own
 * invention (they own it already, via CreatorPlayerId) and a re-buy is a 409 rather
 * than a second row. The grant also resyncs the invention’s `NumDownloads` — the count
 * of players who have it — and the invention returned carries the new number.
 */
async function settleInventionPurchase(
	c: Context<App>,
	id: number,
	inventionId: number,
	requestedPrice: number
): Promise<SettledInventionPurchase | Response> {
	const invention = await getInventionById(c.env.DB, inventionId)
	if (invention === null) return c.json({ error: 'Invention not found' }, 404)
	// An unpublished invention is a draft: it isn't on sale, not even for free.
	if (!invention.IsPublished) return c.json({ error: 'Invention is not for sale' }, 403)
	if (invention.CreatorPlayerId === id) {
		return c.json({ error: 'Cannot buy your own invention' }, 400)
	}
	if (await ownsInvention(c.env.DB, id, inventionId)) {
		return c.json({ error: 'Already owned' }, 409)
	}

	// The price the client rendered must still be the stored one: a mismatch is a stale
	// catalog or a tampered request, never a sale.
	if (invention.Price !== requestedPrice) {
		return c.json({ error: 'Price has changed' }, 409)
	}

	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	// Inventions are priced in RecCenterTokens only — the store shows no other currency
	// for them, and `Price` carries no currency of its own to pick a different one from.
	const price = invention.Price
	if (price > 0) {
		// Debit the buyer atomically; false means they couldn't afford it and nothing
		// changed, so no ownership is recorded and the creator is not paid.
		const paid = await spendCurrency(
			c.env.DB,
			id,
			CurrencyType.RecCenterTokens,
			price,
			startingTokens
		)
		if (!paid) return c.json({ error: 'Insufficient balance' }, 400)
	}

	// Grant before paying out: these are three separate D1 writes with no transaction
	// around them, so order them by what a failure costs. A buyer who paid and got the
	// invention but left the creator unpaid is recoverable; a buyer charged for nothing
	// is not.
	const downloads = await grantInvention(c.env.DB, id, inventionId)

	if (price > 0) {
		// Seed the creator's signup grant BEFORE crediting them: `creditCurrency` upserts
		// the balance row, and `ensureStartingBalances` is an INSERT OR IGNORE, so a
		// creator who had never touched their balance would otherwise have the row created
		// here and lose their starting tokens forever.
		await ensureStartingBalances(c.env.DB, invention.CreatorPlayerId, startingTokens)
		const creatorBalance = await creditCurrency(
			c.env.DB,
			invention.CreatorPlayerId,
			CurrencyType.RecCenterTokens,
			price,
			startingTokens
		)
		// The creator is a different, probably-online player with no response to read:
		// push the sale so it lands on their shown balance without a re-fetch. The frame
		// carries their resulting TOTAL (what `creditCurrency` returns), not the payout —
		// sending the payout would set their whole balance to it. A plain update rather
		// than a purchase frame: they sold, they didn't buy. Best-effort, as everywhere.
		await pushBalanceUpdate(
			c,
			invention.CreatorPlayerId,
			CurrencyType.RecCenterTokens,
			creatorBalance
		)
	}

	// Unlike buyItem — whose `Balance` is the change applied — the reference server
	// answers this one with the RESULTING total (a first read seeds the buyer's starting
	// grant, as everywhere else). The buyer's frame carries that same total, so the body
	// and the push land the client on one number.
	const balance = await getBalance(c.env.DB, id, CurrencyType.RecCenterTokens, startingTokens)
	// A free invention moved nothing, so there is no purchase to report.
	if (price > 0) {
		await pushBalancePurchase(c, id, CurrencyType.RecCenterTokens, -price, balance)
	}
	return { invention: { ...invention, NumDownloads: downloads }, balance }
}

// strict: false so trailing-slash routes (e.g. `/gifts/consume/`, which the client
// posts with a trailing slash) match either form. Mirrors the `api` worker.
const app = new Hono<App>({ strict: false })
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// A batch lookup of LOCKED avatar items — the client posts the descs it wants the locked
	// state for and expects the matching item records back, as a BARE ARRAY.
	//
	// Filtered by exact `AvatarItemDesc`, matching the reference implementation: it walks its
	// own item list and keeps the entries whose desc appears in the posted set. Two consequences
	// of copying that shape rather than the obvious one:
	//
	//  - Order is the CATALOGUE's, not the request's, because the filter iterates the catalogue.
	//    A caller must not read the response positionally against what it asked for.
	//  - The match is the WHOLE desc, not the base asset. `<base>,,,` and `<base>,<colour>,` are
	//    different items and only the one asked for comes back.
	//
	// An EMPTY or absent list means everything, again as the reference does — that is its "give
	// me the catalogue" case rather than a degenerate "match nothing".
	//
	// Unknown descs are simply absent from the response; a miss is not an error. Nothing records
	// a LOCK yet, so what comes back is the item records rather than a genuine locked answer.
	//
	// POST only, despite the reference declaring it `[HttpGet]` with a `[FromBody]` parameter —
	// a combination the fetch standard forbids, so a GET could never carry the descs it needs.
	//
	// NOTE: the `api` worker has a route of this same path that answers `[]`. The client asks
	// THIS host, so that one is unreached; they must be reconciled before either is taken for
	// real behaviour.
	.post(
		'/api/avatar/v1/lockeditems/bulk',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Locked avatar items in bulk',
			description: [
				'Resolves `AvatarItemDescriptions` against the item catalogue (the `catalog` table) and',
				'answers the matching records as a bare array. The match is on the WHOLE `AvatarItemDesc`, so a',
				'colourway is not found by its base asset alone.',
				'An empty or absent list answers the WHOLE catalogue, which is the reference’s own',
				'behaviour rather than a degenerate empty match.',
				'Results come back in CATALOGUE order, not request order — the filter walks the',
				'catalogue — so the response must not be read positionally. Unknown descs are simply',
				'absent; a miss is not an error.',
				'Nothing records a LOCK yet, so what comes back is the item records rather than a',
				'genuine locked/unlocked answer.',
			].join(' '),
			requestBody: jsonBody(LockedItemsBulkRequest, 'The descs to resolve'),
			responses: { 200: json(JsonArray, 'The matching items, in catalogue order') },
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as {
				AvatarItemDescriptions?: unknown
			} | null
			const requested = Array.isArray(body?.AvatarItemDescriptions)
				? body.AvatarItemDescriptions.filter((d): d is string => typeof d === 'string')
				: []
			// The whole kind from the `catalog` table, in LOAD order — which is store order, the
			// closest thing to the reference's "catalogue order" there is — then filtered here.
			// One statement whatever was asked: the client posts hundreds of descs at a time, and
			// D1 binds at most a hundred parameters, so an `IN (...)` of the request cannot be.
			const { results } = await c.env.DB.prepare(
				'SELECT * FROM catalog WHERE kind = ?1 ORDER BY rowid'
			)
				.bind(CatalogKind.AvatarItem)
				.all<CatalogRow>()
			// 2025's BGJHOEKDNED carries `AvatarItemId` as a non-nullable int, while a catalogue
			// row for a store listing can have no id (null). A null in that field costs the
			// 2025 client the whole response, so only that build gets 0 there; 2023 keeps the
			// raw nulls it has always received.
			const build = await authedBuild(c)
			const modern = build !== null && build > Number(GAME_VERSION)
			const catalogue = results
				.map(toCatalogAvatarItem)
				.map((item) => (modern ? { ...item, AvatarItemId: item.AvatarItemId ?? 0 } : item))
			if (requested.length === 0) return c.json(catalogue)

			// A Set rather than `Array.includes` per item: the reference's nested scan is
			// quadratic.
			const wanted = new Set(requested)
			const filtered = catalogue.filter((item) => wanted.has(item.AvatarItemDesc))
			if (!modern) return c.json(filtered)

			// 2025's OutfitManager asks for every item in the outfit, including descriptors
			// the catalog does not know. Omitting one leaves it with a null slot and costs
			// the whole apply; a neutral numeric record is better than a missing entry.
			const found = new Set(filtered.map((item) => item.AvatarItemDesc))
			const placeholders = [...new Set(requested)]
				.filter((desc) => !found.has(desc))
				.map((desc) => ({
					AvatarItemDesc: desc,
					AvatarItemType: 0,
					PlatformMask: -1,
					FriendlyName: '',
					Tooltip: '',
					Rarity: 0,
					TagList: '',
					AvatarItemId: 0,
					IsBaseAvatarItem: false,
				}))
			return c.json([...filtered, ...placeholders])
		}
	)

	// Default-unlocked avatar items, served from the bundled static JSON.
	.get(
		'/api/avatar/v1/defaultunlocked',
		listRoute('Default-unlocked avatar items', 'The bundled default avatar-item catalog'),
		// The captured catalog carries `TagList: null` and `Tooltip: null` on many rows. The
		// 2023 client runs LINQ transforms over those fields and throws
		// `ArgumentNullException: source` on a null list, so serve the empty-string/zero form
		// the v4 projection already uses.
		(c) =>
			c.json(
				defaultAvatarItems.map((item) => ({
					...item,
					TagList: item.TagList ?? '',
					Tooltip: item.Tooltip ?? '',
					AvatarItemId: item.AvatarItemId ?? 0,
				}))
			)
	)

	// The base items UGC clothing is built on top of — served from bundled static JSON,
	// separate from the `defaultunlocked` catalog. No auth.
	.get(
		'/api/avatar/v1/defaultbaseavataritems',
		listRoute('Default base avatar items', 'The bundled base items UGC clothing builds on'),
		(c) =>
			c.json(
				defaultBaseAvatarItems.map((item) => ({
					...item,
					TagList: item.TagList ?? '',
					Tooltip: item.Tooltip ?? '',
					AvatarItemId: item.AvatarItemId ?? 0,
				}))
			)
	)

	// The player's avatar items — the items they've bought (from `buyItem`, stored in
	// the inventory table) prepended to the default catalog. A player who has bought
	// nothing gets just the catalog.
	.get(
		'/api/avatar/v4/items',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s avatar items',
			description: [
				'The items the player has bought (from buyItem, in the inventory table) prepended',
				'to the default catalog. A player who has bought nothing gets just the catalog.',
				'Both sources are projected into the camelCase v4 DTO — the sibling item endpoints',
				'(`defaultunlocked`, `defaultbaseavataritems`) serve their records raw instead.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(AvatarItemV4Dto.array(), 'Owned items followed by the default catalog'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const owned = await getInventory(c.env.DB, id)

			// 2025's locker gets every avatar item the served store sells. This is a
			// READ-ONLY overlay: nothing is written to the shared inventory, and the
			// 2023 response is exactly the owned items plus the default catalog.
			const build = await authedBuild(c)
			let wardrobe: WardrobeItem2025[] = []
			if (build !== null && build > Number(GAME_VERSION)) {
				wardrobe = allAvatarItems2025(await store2025Listings(c.env.ASSETS, c.req.url))
			}
			const known = new Set(
				[...owned, ...defaultAvatarItems].map((item) =>
					String((item as Record<string, unknown>).AvatarItemDesc ?? '')
				)
			)
			const items = [
				...owned,
				...defaultAvatarItems,
				...wardrobe.filter((item) => !known.has(item.AvatarItemDesc)),
			].map(toAvatarItemV4)
			// A 2023 wardrobe is keyed by item id. Old purchases lack ids entirely and are
			// returned as 0; duplicates of default items can also appear in the inventory.
			// Correct only the response, leaving stored inventory and descriptors unchanged.
			return c.json(build === null || build <= Number(GAME_VERSION) ? legacyWardrobeItems(items) : items)
		}
	)

	.get(
		'/econ/customAvatarItems/v1/ownedby/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Custom avatar items owned by an account',
			description:
				'Lists owned and created items, filtered by outfitType and paged by skip/take. ' +
				'TotalResults is the filtered count before paging. Other accounts see published items only. ' +
				'Honors unityAssetTarget as the caller-owned inventory does.',
			security: AUTHED,
			responses: {
				200: json(CustomAvatarItemsResponse, 'The owned items'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return customAvatarItemsPage(c, Number(c.req.param('accountId')), id)
		}
	)
	.post(
		'/circuitsRoomRewards/grantRoomBadge',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Award a room badge from a circuit',
			description:
				'Grants a published room badge to a player in the caller’s live room instance. ' +
				'The badge must belong to that room. ResponseCode is 0 on a new grant, 1 if already owned, ' +
				'or 2 on an invalid grant. A new grant creates and announces a gift package.',
			security: AUTHED,
			requestBody: jsonBody(GrantRoomBadgeRequest, 'The badge, player and room instance'),
			responses: {
				200: json(GrantRoomBadgeResponse, 'The circuit result'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const failed = (ErrorMessage: string) => c.json({ ResponseCode: 2, ErrorMessage })
			const parsed = GrantRoomBadgeRequest.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return failed('Invalid room badge request')
			const body = parsed.data
			const [badge] = await getCustomAvatarItems(c.env.DB, [
				body.BadgeCustomAvatarItemId.toLowerCase(),
			])
			const roomId = (badge?.CustomBadgeMetadata as { RoomId?: number } | null)?.RoomId
			if (
				!badge ||
				badge.OutfitType !== 1000 ||
				badge.Accessibility === 0 ||
				badge.CurrentSaves.length === 0 ||
				!roomId
			)
				return failed('No published room badge')
			type BadgeInstance = { roomId: number; roomInstanceId: number }
			const [caller, target] = await Promise.all([
				getPresence<BadgeInstance>(c.env.DB, id),
				getPresence<BadgeInstance>(c.env.DB, body.TargetAccountId),
			])
			if (
				caller?.roomInstance?.roomId !== roomId ||
				caller.roomInstance.roomInstanceId !== body.RoomInstanceId ||
				target?.roomInstance?.roomId !== roomId ||
				target.roomInstance.roomInstanceId !== body.RoomInstanceId
			) {
				return failed('Players must be in the badge’s room instance')
			}
			const owned = await ownedCustomAvatarItemIds(c.env.DB, body.TargetAccountId, [
				badge.CustomAvatarItemId,
			])
			if (badge.CreatorAccountId === body.TargetAccountId || owned.size > 0) {
				return c.json({ ResponseCode: 1, ErrorMessage: null })
			}
			// The insert decides the winner of concurrent grants, so only one box is created.
			if (
				!(await grantCustomAvatarItem(c.env.DB, body.TargetAccountId, badge.CustomAvatarItemId))
			) {
				return c.json({ ResponseCode: 1, ErrorMessage: null })
			}
			const content = toCustomGiftContent(
				badge,
				censorSwears(body.GrantMessage ?? ''),
				COACH_ACCOUNT_ID,
				null
			)
			const box = await createGift(c.env.DB, body.TargetAccountId, content)
			await pushCustomGiftReceived(c, body.TargetAccountId, box.id, content)
			return c.json({ ResponseCode: 0, ErrorMessage: null })
		}
	)

	// The player's owned custom avatar items. [Authorize]; the paginated envelope. What the
	// caller has BOUGHT through bulkpurchase (`inventory_custom`) plus what they CREATED, each
	// the whole `CustomAvatarItem` record out of the item table. The client downloads these
	// when custom-item creation is allowed; a 404 here surfaces as "Failed to download
	// unlocked avatar items".
	.get(
		'/econ/customAvatarItems/v1/owned',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Owned custom avatar items',
			description: [
				'The custom avatar items the caller owns — bought (`POST /api/items/bulkpurchase` with',
				'a guid-keyed line) or created (`CreatorAccountId`, drafts included) — each as its full',
				'`CustomAvatarItem` record out of the `custom_avatar_item` table, oldest first by when',
				'it became theirs, in the `{ Results, TotalResults }` envelope. No paging is applied',
				'(the client sends none), so `TotalResults` is the list’s length.',
				'`unityAssetTarget` 2 (Android/Oculus) serves each save’s `UnityAsset`/`UnityAsset2`',
				'under `quest/`, the Android build of the same assetbundle — the same switch `api`’s',
				'search and bulk reads make; 0 (PC), any other value, and none get the names as stored.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(CustomAvatarItemsResponse, 'The owned items'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const owned = await getOwnedCustomAvatarItems(c.env.DB, id)
			// The client renders what the player is WEARING from this list, and it is read before
			// any `api` lookup — so a Quest served PC names here downloads PC assetbundles however
			// the search and bulk reads answer.
			const Results = isQuestAssetTarget(c.req.query('unityAssetTarget'))
				? owned.map(toQuestCustomAvatarItem)
				: owned
			return c.json({ Results, TotalResults: Results.length })
		}
	)

	// The player's objectives progress. Serves a static JSON file verbatim with
	// no auth — same default for everyone until there's a DB binding to track
	// per-player progress.
	.get(
		'/api/objectives/v1/myprogress',
		describeRoute({
			tags: ['Econ'],
			summary: 'Objectives progress',
			description:
				'Serves the bundled static progress verbatim (no per-player store yet). No auth.',
			responses: { 200: json(JsonObject, 'The bundled objectives-progress default') },
		}),
		(c) => c.json(myProgress)
	)

	// Clears a group of objectives. No per-player progress to clear yet, so this is
	// a no-op — but the response has to be a JSON OBJECT. The client deserialises this
	// body as one, and a bare `[]` makes it log `expected '}', actual: '['` and throw
	// away the local objective state ("Local objective state will not be reflected in
	// server!"), so we echo the posted group back as cleared instead. Accepts GET or
	// POST since the client may use either.
	.on(
		['GET', 'POST'],
		'/api/objectives/v1/cleargroup',
		describeRoute({
			tags: ['Econ'],
			summary: 'Clear an objectives group (no-op)',
			description:
				'Nothing is persisted yet: echoes the posted group back as cleared. Always an object, never an array.',
			responses: { 200: json(UpdateObjectiveResponse, 'The echoed group, cleared now') },
		}),
		async (c) => {
			const body = await c.req
				.json<{ Group?: string | number }>()
				.catch(() => ({}) as Record<string, never>)
			return c.json({
				group: Number(body.Group) || 0,
				isCompleted: false,
				clearedAt: new Date().toISOString(),
			})
		}
	)

	// Report one objective's progress. The client posts the whole objective as it now
	// sees it (Index/Group identify it within `myprogress`) and reads back the state of
	// the GROUP that objective belongs to — camelCase here, unlike the PascalCase body it
	// posted. Stubbed: with no objectives store yet we persist nothing, echo the group
	// back and never complete it, so the reward-claim flow isn't triggered. `clearedAt`
	// is the clear time, which for a group we didn't clear is just now.
	.post(
		'/api/objectives/v1/updateobjective',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report objective progress',
			description: [
				'Stubbed: with no objectives store we persist nothing and never complete a group.',
				'Echoes `Group` back as camelCase `group` with `isCompleted: false` so the client',
				'gets a well-formed body.',
			].join(' '),
			requestBody: jsonBody(UpdateObjectiveRequest, 'The objective as the client now sees it'),
			responses: { 200: json(UpdateObjectiveResponse, 'The echoed group, never completed') },
		}),
		async (c) => {
			const body = await c.req
				.json<{ Group?: string | number }>()
				.catch(() => ({}) as Record<string, never>)
			return c.json({
				group: Number(body.Group) || 0,
				isCompleted: false,
				clearedAt: new Date().toISOString(),
			})
		}
	)

	// The player's avatar, stored as a JSON blob on their account row. Falls back
	// to the default outfit when they haven't saved one — the client's parser NREs
	// on an empty OutfitSelections (real RecNet never returns one).
	.get(
		'/api/avatar/v2',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s own avatar',
			description: [
				'The avatar JSON blob stored on the account row, or the default outfit when none is',
				'saved (the client NREs on an empty OutfitSelections).',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonObject, 'The stored avatar blob (or the default)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json((await getAvatar(c.env.DB, id)) ?? defaultAvatar)
		}
	)

	// Save the player's avatar. [Authorize]. Stores the posted JSON payload verbatim
	// on the account row and echoes it back. 400 on a non-object body; 404 when the
	// caller has no account row to attach it to.
	.post(
		'/api/avatar/v2/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save the player’s avatar',
			description: 'Stores the posted JSON blob verbatim on the account row and echoes it back.',
			security: AUTHED,
			requestBody: jsonBody(OpaqueJsonBody, 'The avatar blob'),
			responses: {
				200: json(JsonObject, 'The saved avatar (echoed back)'),
				400: { description: 'Body was not a JSON object (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
				404: { description: 'No account row to attach it to (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const avatar = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (avatar === null || typeof avatar !== 'object' || Array.isArray(avatar)) {
				return c.body(null, 400)
			}
			if (!(await setAvatar(c.env.DB, id, avatar))) return c.body(null, 404)
			return c.json(avatar)
		}
	)

	// NUX checklist — the client fetches this on the econ host during load, on either
	// version path. A 404 here can abort the load orchestration before matchmake. We
	// serve the default brand-new-account list to everyone: nothing records per-player
	// checklist progress yet, so it never shrinks as steps are done.
	.on(
		'GET',
		['/api/checklist/v1/current', '/api/checklist/v2/current'],
		describeRoute({
			tags: ['Econ'],
			summary: 'NUX checklist',
			description:
				'The new-user checklist, as the default brand-new-account list — nothing records ' +
				'per-player progress yet, so the same rows come back however much the player has ' +
				'done. `Objective` is an `ObjectiveType` ordinal the client matches its own ' +
				'progress events against. v1 and v2 serve the same list.',
			security: AUTHED,
			responses: {
				200: json(ChecklistEntry.array(), 'The checklist rows, in `Order`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(DEFAULT_CHECKLIST)
		}
	)

	// Mark a checklist row done. [Authorize]. Stubbed: there is no objective-progress
	// table to record the completion in, and no reward ledger to make the 25-token grant
	// once-only — without one, re-posting the same row would mint tokens indefinitely, so
	// we grant nothing and report a change of 0. The envelope is still the balance-update
	// shape the client parses, so the flow completes instead of erroring.
	.on(
		'POST',
		['/api/checklist/v1/complete', '/api/checklist/v2/complete'],
		describeRoute({
			tags: ['Econ'],
			summary: 'Complete a checklist row (stub)',
			description:
				'Marks a NUX checklist row done. Stubbed: nothing records the completion (no ' +
				'objective-progress table) and nothing is granted — a reward is worth 25 XP and 25 ' +
				'tokens, but making that once-only needs a ledger we do not have, and without one ' +
				're-posting the same row would mint tokens indefinitely. The response is still the ' +
				'balance-update envelope, with `Balance` (the change) 0. v1 and v2 behave alike.',
			security: AUTHED,
			requestBody: jsonBody(CompleteChecklistRequest, 'Which row was completed — `{ ItemIndex }`'),
			responses: {
				200: json(ChecklistCompleteResponse, 'The balance-update envelope, granting nothing'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			// The body names the row (`{ ItemIndex: 1 }`, or `Id` as a fallback) — read only
			// once there is somewhere to record it.
			return c.json({
				BalanceUpdates: [{ UpdateResponse: CHECKLIST_REWARD_CONTEXT, Data: [] }],
				Balance: 0,
				CurrencyType: CurrencyType.RecCenterTokens,
				BalanceType: -2,
			})
		}
	)

	// The caller's item wishlist. [Authorize]. A bare array of entries, newest wish first;
	// `[]` for a player who has wished for nothing. The client appends a KEYLESS query string
	// (`/me?True`, `/me?False` — a raw `bool.ToString()` after the `?`, no parameter name) that
	// no server can bind by name, so it is ignored: both spellings serve the same list. The
	// client caches this for five seconds and drops the cache when an add succeeds.
	.get(
		'/api/itemWishlists/v1/wishlist/me',
		describeRoute({
			tags: ['Econ'],
			summary: 'The player’s item wishlist',
			description: [
				'The caller’s wishlist as a bare array of entries, newest first — `[]` when empty.',
				'Each entry names ONE item: a storefront item by `PurchasableItemId`, or a custom',
				'avatar item by `CustomAvatarItemId` (with `PurchasableItemId` 0, the client’s field',
				'being a plain int).',
				'',
				'The client appends `?True` or `?False` with no parameter name; it cannot be read',
				'and is ignored — both serve the same list.',
			].join('\n'),
			security: AUTHED,
			responses: {
				200: json(WishlistItemList, 'The caller’s wishlist, newest first'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getWishlist(c.env.DB, id))
		}
	)

	// Another player's item wishlist, by account id — what the client reads to show what
	// somebody else is hoping for. Public to any signed-in player: a wishlist exists to be
	// read by others. An unknown account has simply wished for nothing.
	//
	// Registered AFTER `/me` so that path stays its own route rather than being read as an
	// account id — the pattern here is digits-only, so it could not swallow `me`, but the
	// order also says which is the special case.
	.get(
		'/api/itemWishlists/v1/wishlist/:accountId{[0-9]+}',
		describeRoute({
			tags: ['Econ'],
			summary: 'Another player’s item wishlist',
			description: [
				'The wishlist of the account named in the path, as a bare array of entries, newest',
				'first. Readable by any signed-in player — a wishlist is for others to see. An',
				'unknown account answers `[]`, which the client renders as “nothing wished for”',
				'where a 404 would read as a failed load. The keyless `?True`/`?False` the client',
				'appends is ignored, as on `/me`.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'accountId',
					in: 'path',
					required: true,
					description: 'The account whose wishlist to read',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: {
				200: json(WishlistItemList, 'That player’s wishlist, newest first'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const accountId = Number.parseInt(c.req.param('accountId'), 10)
			if (!Number.isInteger(accountId)) return c.json([])
			return c.json(await getWishlist(c.env.DB, accountId))
		}
	)

	// Wish for an item. [Authorize]. Form-encoded: the client posts BOTH `purchasableItemId`
	// and `customAvatarItemId` every time with the unused one empty (its two nullables are
	// boxed without a HasValue guard), so either may be empty or absent; exactly one has to
	// name an item. Answers the `{ Value, Success, Error, error_id }` envelope with the entry.
	// An item already on the list answers its EXISTING entry: the toggle is driven by the
	// client's idea of the current state, and re-adding changes nothing.
	//
	// The row has to persist: on success the client drops its cached list and re-reads it,
	// so a 200 that stored nothing shows the heart un-filling again at once.
	.post(
		'/api/itemWishlists/v1/wishlist/add',
		describeRoute({
			tags: ['Econ'],
			summary: 'Wish for an item',
			description: [
				'Adds an item to the caller’s wishlist. Form-encoded; the client posts both',
				'`purchasableItemId` and `customAvatarItemId` with the unused one EMPTY',
				'(`purchasableItemId=1534&customAvatarItemId=`), and either may also be absent —',
				'exactly one has to name an item.',
				'',
				'Answers `{ Value, Success, Error, error_id }` with the entry as `Value`. An item',
				'already on the list answers its existing entry rather than a twin or a refusal.',
				'A body naming no item is `Success: false` with a player-readable `Error` — the',
				'client shows it verbatim behind “Wishlist error: ”. A bare entry or a 204 fails the',
				'client the same way `Success: false` does.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(WishlistItemRequest, 'The item to wish for'),
			responses: {
				200: json(WishlistEnvelope, 'The entry, or a refusal in the same shape'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await wishlistTargetFromBody(c)
			if (target === null) return wishlistEnvelope(c, null, WISHLIST_NO_ITEM)
			return wishlistEnvelope(c, await addWishlistItem(c.env.DB, id, target))
		}
	)

	// Take an item off the caller's wishlist. [Authorize]. A POST, not a DELETE, with the same
	// form body as `add`. The client parses the same envelope and discards `Value`, so the
	// removed entry is served anyway; an item that wasn't on the list is still a success —
	// the list ends up as asked — with a null `Value`.
	.post(
		'/api/itemWishlists/v1/wishlist/remove',
		describeRoute({
			tags: ['Econ'],
			summary: 'Un-wish an item',
			description: [
				'Removes an item from the caller’s wishlist. A POST (not a DELETE) with the same',
				'form body as `add`. Answers the same envelope with the REMOVED entry as `Value`;',
				'the client discards it but parses the shape, so a bare body or 204 fails it. An',
				'item that wasn’t on the list is still `Success: true`, with a null `Value`. A body',
				'naming no item is `Success: false`.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(WishlistItemRequest, 'The item to un-wish'),
			responses: {
				200: json(WishlistEnvelope, 'The removed entry, or a refusal in the same shape'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const target = await wishlistTargetFromBody(c)
			if (target === null) return wishlistEnvelope(c, null, WISHLIST_NO_ITEM)
			return wishlistEnvelope(c, await removeWishlistItem(c.env.DB, id, target))
		}
	)

	// Whether each of several players has an item wished for. [Authorize]. Form-encoded:
	// `accountIds` repeated once per player plus the item named as on add/remove. A BARE
	// positional array of booleans back, one per id in the order posted — a short array would
	// leave the tail reading as unset, so every id is answered, unknown players as false.
	.post(
		'/api/itemWishlists/v1/isonwishlist/bulk',
		describeRoute({
			tags: ['Econ'],
			summary: 'Whether players have an item wished for',
			description: [
				'For each `accountIds` entry, whether that player’s wishlist has the item named by',
				'`purchasableItemId` or `customAvatarItemId`. Form-encoded, `accountIds` repeated',
				'once per id (a comma-separated single value is accepted too). The answer is a BARE',
				'array of booleans, one per id in the order posted. A body naming no item answers',
				'false for everyone.',
			].join(' '),
			security: AUTHED,
			requestBody: form(IsOnWishlistBulkRequest, 'The players to ask about, and the item'),
			responses: {
				200: json(IsOnWishlistBulkResponse, 'One boolean per `accountIds` entry, in order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.parseBody({ all: true })
				.catch(() => ({}) as Record<string, string | string[] | File | File[]>)
			// `all: true` keeps the repeated field a list; a single value arrives as a string.
			const accountIds = [body.accountIds, body.AccountIds]
				.flat()
				.filter((v): v is string => typeof v === 'string')
				.flatMap((v) => v.split(','))
				.map((v) => Number.parseInt(v.trim(), 10))
				.filter((n) => Number.isInteger(n))
			const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)
			const target = parseWishlistTarget(
				first(body.purchasableItemId ?? body.PurchasableItemId),
				first(body.customAvatarItemId ?? body.CustomAvatarItemId)
			)
			if (target === null) return c.json(accountIds.map(() => false))
			return c.json(await isOnWishlists(c.env.DB, accountIds, target))
		}
	)

	// The player's saved outfits. [Authorize]. Served back as the client posted them
	// (see /saved/set); a player who has saved none gets [].
	.get(
		'/api/avatar/v3/saved',
		describeRoute({
			tags: ['Avatar'],
			summary: 'The player’s saved outfits',
			description: 'Served back as the client posted them (see /saved/set); [] when none.',
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Saved outfits (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getOutfits(c.env.DB, id))
		}
	)

	// Save an outfit into one of the player's slots. [Authorize]. The posted `Slot` is
	// the slot to write, and re-saving a slot overwrites it — that's the avatar screen's
	// "save over this outfit". The payload is stored verbatim and echoed back: its inner
	// fields (OutfitSelectionsV2, FaceFeatures, …) are JSON-in-a-string from the client's
	// own serializer, so re-encoding them risks handing back something it can't parse.
	//
	// A missing/non-integer `Slot` is a 400 rather than a default slot — guessing would
	// silently overwrite an outfit the player didn't mean to touch.
	//
	// v3 and v4 share this handler: newer clients POST to /v4/saved/set with the same
	// payload shape (Slot, PreviewImageName, OutfitSelections(V2), FaceFeatures, Skin/HairColor,
	// CustomAvatarItems) and expect the same slot-overwrite semantics, so they store into the
	// same outfit table and read back through /api/avatar/v3/saved.
	.post(
		'/api/avatar/v3/saved/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save an outfit into a slot',
			description: [
				'Writes the posted outfit into the given `Slot` (overwriting it) and echoes it back.',
				'The payload is stored verbatim — its inner fields are JSON-in-a-string from the',
				'client’s own serializer. A missing/non-integer `Slot` is a 400 (guessing would',
				'silently overwrite another outfit).',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(SaveOutfitRequest, 'The outfit, with a target Slot'),
			responses: {
				200: json(JsonObject, 'The saved outfit (echoed back)'),
				400: { description: 'Non-object body or missing/non-integer Slot (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const result = await persistPostedOutfit(c)
			if (result instanceof Response) return result
			return c.json(result)
		}
	)

	// v4 of the save-outfit route. Same payload, table and slot-overwrite semantics as v3
	// (see above) — newer clients moved to /v4/saved/set. The one difference is the response:
	// v4 answers a lean `{ Success, Slot }` acknowledgement rather than echoing the whole
	// outfit back. The outfit is read back through /api/avatar/v3/saved either way.
	.post(
		'/api/avatar/v4/saved/set',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Save an outfit into a slot (v4)',
			description: [
				'Writes the posted outfit into the given `Slot` (overwriting it), same as',
				'`POST /api/avatar/v3/saved/set`, but answers a lean `{ Success, Slot }` ack instead',
				'of echoing the outfit. A missing/non-integer `Slot` is a 400.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(SaveOutfitRequest, 'The outfit, with a target Slot'),
			responses: {
				200: json(SaveOutfitV4Response, 'Save acknowledgement'),
				400: { description: 'Non-object body or missing/non-integer Slot (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const result = await persistPostedOutfit(c)
			if (result instanceof Response) return result
			return c.json({ Success: true, Slot: result.Slot })
		}
	)

	// Pending avatar gifts for the player — the unopened gift boxes from their purchases
	// (and, once gifting lands, from other players). [Authorize]. The client opens each
	// box and consumes it via the consume route below; the item itself was already
	// granted at purchase, so an unopened box is cosmetic.
	.get(
		'/api/avatar/v2/gifts',
		describeRoute({
			tags: ['Gifts'],
			summary: 'Pending gift boxes',
			description: [
				'The player’s unopened gift boxes from their purchases (and, later, from other',
				'players). The item was already granted at purchase, so an unopened box is cosmetic.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Unopened gift boxes (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getPendingGifts(c.env.DB, id))
		}
	)

	// Open (consume) a gift box. [Authorize]. The client posts this on the econ host after
	// the box animation, form-encoded as `Id=<giftId>&UnlockedLevel=<n>`. Opening just
	// deletes the box — the item was granted into the inventory at purchase, so there's
	// nothing to grant here — an avatar-item drop was granted into the inventory table and a
	// consumable drop into the consumable table, both at purchase. (`UnlockedLevel`, a
	// consumable-level hint, is unused.)
	//
	// Always answers 200 with the `{ error, success, value }` envelope — even with no token,
	// a zero id, or a box that is already gone. A captured real consume returns this envelope,
	// not an empty body: the client parses it to finish opening the box, so a bare 200 reads
	// as a failure and the consumable never finishes unlocking. The delete is scoped to the
	// caller's account, so an unauthenticated or mismatched call is simply a no-op. Mirrors
	// the same route on the `api` worker (the client may call either host).
	.post(
		'/api/avatar/v2/gifts/consume',
		describeRoute({
			tags: ['Gifts'],
			summary: 'Open (consume) a gift box',
			description: [
				'Deletes the box (the item was already granted at purchase). Always answers the',
				'`{ error, success, value }` envelope with HTTP 200 — even with no token, a zero id,',
				'or a box already gone — because the client parses it to finish opening the box. The',
				'delete is scoped to the caller; opening someone else’s box is 403. Also served by',
				'the `api` worker.',
			].join(' '),
			requestBody: form(ConsumeGiftRequest, 'The gift-box id'),
			responses: {
				200: json(ConsumeEnvelope, 'Success envelope'),
				403: { description: 'The box belongs to another player (empty body)' },
			},
		}),
		async (c) => {
			const id = await authedId(c)
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const giftId = typeof body.Id === 'string' ? Number.parseInt(body.Id, 10) || 0 : 0
			if (id !== null && giftId !== 0) {
				// Scoped delete: only the box's owner deletes it. A returned box means it was
				// theirs and is now consumed.
				const gift = await consumeGift(c.env.DB, id, giftId)
				if (gift !== null) {
					// If the box carried a consumable, tell the client it now has it (so it shows
					// up in inventory without a refetch). Avatar-item boxes carry no ConsumableItemDesc.
					if (gift.ConsumableItemDesc !== '') await pushConsumableAdded(c, id, gift)
					// A box carrying CURRENCY pays out HERE. Every purchased item is granted at buy
					// time, so its box is cosmetic — but a token box has nothing granted until it is
					// opened, and crediting the balance is what makes the drop real instead of an
					// animation over nothing. `CurrencyType` 0 means the box named no currency, which
					// is not a token box and is left alone.
					if (gift.Currency > 0 && gift.CurrencyType > 0) {
						await creditCurrency(
							c.env.DB,
							id,
							gift.CurrencyType,
							gift.Currency,
							intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
						)
					}
				} else {
					// Nothing was consumed: either the box is already gone (a harmless no-op —
					// re-opening your own consumed box still succeeds) or it belongs to another
					// player, which is forbidden.
					const other = await getGift(c.env.DB, giftId)
					if (other !== null && other.accountId !== id) return c.body(null, 403)
				}
			}
			return c.json({ error: '', success: true, value: null })
		}
	)

	// A player's avatar by account id, projected to the public render subset (used
	// to draw other players' avatars). No auth — like the accounts `/account/:id`
	// lookup. Falls back to the default outfit when the player hasn't saved one.
	// Registered after the static `/api/avatar/v2/*` routes so `:id` can't shadow them.
	.get(
		'/api/avatar/v2/:id',
		describeRoute({
			tags: ['Avatar'],
			summary: 'Another player’s avatar (render subset)',
			description: [
				'The public render subset used to draw another player’s avatar. No auth. Falls back',
				'to the default outfit when the player hasn’t saved one.',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Account id; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(AvatarV2Dto, 'The render subset'),
				400: { description: 'Non-numeric id (empty body)' },
			},
		}),
		async (c) => {
			const accountId = Number.parseInt(c.req.param('id'), 10)
			if (Number.isNaN(accountId)) return c.body(null, 400)
			return c.json(toAvatarV2Dto((await getAvatar(c.env.DB, accountId)) ?? defaultAvatar))
		}
	)

	// Unlocked equipment. [Authorize]. The equipment skins the player has bought (from
	// `buyItem`, stored in the `equipment` table). A player who has bought none gets an
	// empty list.
	.get(
		'/api/equipment/v2/getUnlocked',
		listRoute('Unlocked equipment', 'The equipment skins the player has bought', true),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getEquipment(c.env.DB, id))
		}
	)

	// Favourite/un-favourite owned equipment. [Authorize]. The client sends the entries it
	// wants changed (one request can carry several) and reads nothing back. Only
	// `Favorited` is written — the rest of each entry is the client echoing what it was
	// served, and a guid the caller doesn't own matches no row and is dropped.
	//
	// PUT or POST: the client uses both spellings for this one call, with an identical body
	// either way, so they are the same route rather than two handlers. A 404 on the POST
	// leaves the star drawn on the item the client already redrew, and the favourite
	// silently doesn't stick.
	.on(
		['PUT', 'POST'],
		'/api/equipment/v1/update',
		describeRoute({
			tags: ['Equipment'],
			summary: 'Update owned equipment',
			description: [
				'Applies the posted `Favorited` flags to the caller’s owned equipment, matched by',
				'`ModificationGuid`. Everything else in each entry is ignored, and a guid the caller',
				'doesn’t own is silently skipped. Empty body on success. Accepts PUT or POST — the',
				'client uses both, with the same body.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(EquipmentUpdateRequest, 'The entries to update'),
			responses: {
				200: { description: 'Applied (empty body)' },
				400: { description: 'Body isn’t a JSON array (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = (await c.req.json().catch(() => null)) as unknown
			if (!Array.isArray(body)) return c.body(null, 400)
			const updates = body
				.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
				.filter((e) => typeof e.ModificationGuid === 'string' && e.ModificationGuid !== '')
				.map((e) => ({
					ModificationGuid: e.ModificationGuid as string,
					Favorited: e.Favorited === true,
				}))
			await setEquipmentFavorited(c.env.DB, id, updates)
			return c.body(null, 200)
		}
	)

	// A room's shop — the things it sells for its own currency. Public, like the room's
	// currencies: a shop is shown to everyone who walks in.
	.get(
		'/api/roomconsumables/v1/roomConsumable/room/:roomId',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s consumables',
			description: [
				'Everything the room sells — a Health Potion for 25 tokens, a custom shirt for 500 —',
				'oldest first, which is the order its owner built the shop up in.',
				'',
				'`Price` and `PurchaseCurrencyId` are FLAT here, against the nested',
				'`PriceAndCurrency` the write takes: the client sends them nested and reads them',
				'flat, so the two shapes genuinely differ. `PurchaseCurrencyId` names one of the',
				'room’s own currencies and is not resolved or validated — a listing priced in a',
				'currency that has since been deleted still shows, at a price nobody can pay.',
				'',
				'Public, like `GET /api/roomcurrencies/v1/currencies`. A room that sells nothing, and',
				'an unknown room, are both an empty list — which the client reads as "no shop here"',
				'where a 404 would stall the room load.',
			].join('\n'),
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					description: 'The room whose shop to list',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(RoomConsumableDto.array(), 'The room’s consumables, oldest first') },
		}),
		async (c) => {
			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			if (!Number.isInteger(roomId)) return c.json([])
			return c.json(await getRoomConsumables(c.env.DB, roomId))
		}
	)

	// Give the CALLER some of a room's consumables. Auth-gated (401); everything else is
	// reported per entry, like the room-currency award.
	.post(
		'/api/roomconsumables/v1/roomConsumable/awardBulk',
		describeRoute({
			tags: ['Econ'],
			summary: 'Award room consumables to the caller',
			description: [
				'Adds to what the CALLER owns of a room’s consumables — the token says who is being',
				'given them, and there is no recipient in the body.',
				'',
				'`Requests` is a MAP keyed by consumable id, not a list: `{ "<id>": { "Quantity": 1,',
				'"ConcurrencyCodes": { … } } }`. `ConcurrencyCodes` is accepted and IGNORED — no',
				'optimistic concurrency is implemented, so `NewConcurrencyCode` is neither stored nor',
				'echoed and a stale `CurrentConcurrencyCode` does not refuse the write.',
				'',
				'The answer is one result per entry, in the order the keys appeared, each standing',
				'alone: an id naming no listing fails that entry and leaves the rest to land. Shaped',
				'after the room-currency bulk award rather than observed.',
				'',
				'`Quantity` may be negative, which takes items away; a player’s count floors at zero.',
				'`Quantity` on the result is the RESULTING total owned, never the change.',
				'',
				'NOTE: this awards to whoever is asking, and nothing is spent for it — no room',
				'currency is debited and no room membership is checked. It is a self-service faucet',
				'until a purchase flow sits in front of it.',
			].join('\n'),
			security: AUTHED,
			requestBody: jsonBody(AwardRoomConsumablesRequest, 'The consumables to give the caller'),
			responses: {
				200: json(
					AwardRoomConsumableResultList,
					'One result per entry, in the order the keys appeared'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = await c.req.json<{ Requests?: unknown }>().catch(() => null)
			const requests = body?.Requests
			// A body carrying no map of requests has no entries to report on, and the answer is
			// a list of entry results — so there is nothing to say but "none".
			if (typeof requests !== 'object' || requests === null || Array.isArray(requests)) {
				return c.json([])
			}

			const results = []
			for (const [consumableId, request] of Object.entries(requests as Record<string, unknown>)) {
				const quantity = Number(
					(typeof request === 'object' && request !== null
						? (request as { Quantity?: unknown }).Quantity
						: Number.NaN) ?? Number.NaN
				)
				if (!Number.isInteger(quantity)) {
					results.push({
						ConsumableId: consumableId,
						Success: false,
						Error: 'Invalid quantity',
						Response: null,
					})
					continue
				}

				// Checked before writing: an inventory row naming no listing would be a thing a
				// player owns that cannot be described.
				const consumable = await getRoomConsumable(c.env.DB, consumableId)
				if (!consumable) {
					results.push({
						ConsumableId: consumableId,
						Success: false,
						Error: 'No such consumable',
						Response: null,
					})
					continue
				}

				const code = (request as { ConcurrencyCodes?: { NewConcurrencyCode?: unknown } })
					.ConcurrencyCodes?.NewConcurrencyCode
				const owned = await awardRoomConsumable(
					c.env.DB,
					accountId,
					consumableId,
					quantity,
					typeof code === 'string' ? code : null
				)
				results.push({
					ConsumableId: consumableId,
					Success: true,
					Error: null,
					Response: {
						PlayerId: accountId,
						ConsumableId: consumableId,
						Quantity: owned.quantity,
						AwardedAt: new Date().toISOString(),
					},
				})
			}

			return c.json(results)
		}
	)

	// Buy some of a room's consumables, for the caller or as a gift. One route for both kinds of
	// price: a listing in TOKENS pays the room's owner, as a room key does; a listing in a ROOM
	// CURRENCY pays nobody — that money is the room's own invention. What is bought lands in
	// `room_inventory`, the same holding `awardBulk` adds to.
	.put(
		// Two paths, one sale: the client posts a token listing to `/purchase/tokens` and a
		// room-currency one to `/purchase/currency`, with the same body. The body's
		// `ExpectedPriceAndCurrency` is what is checked against the listing, not the path.
		'/api/roomconsumables/v1/roomconsumable/:id/purchase/:via{currency|tokens}',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a room consumable',
			description: [
				'Buys `Quantity` of the consumable named in the path, at its listed price EACH.',
				'The client posts a listing priced in tokens to `…/purchase/tokens` and one priced',
				'in a room currency to `…/purchase/currency`; both take the same body and answer',
				'the same way, and it is the body’s `ExpectedPriceAndCurrency` that must match.',
				'',
				'`ExpectedPriceAndCurrency` must be the listing’s own: `Price` its unit price and',
				'`CurrencyId` its `PurchaseCurrencyId` — null for a listing priced in tokens.',
				'`Quantity` must be at least 1 and, when the listing sets one, at most its',
				'`MaximumCountPerPurchase`. `ConcurrencyCodes` is accepted and IGNORED.',
				'',
				'- In TOKENS: the total leaves the buyer and is paid to the room’s OWNER, who gets a',
				'  StorefrontBalanceUpdate; the buyer gets a StorefrontBalancePurchase. Both carry',
				'  a resulting total.',
				'- In a ROOM CURRENCY: the total leaves the buyer’s holding of it (`room_balance`)',
				'  and NOBODY is paid.',
				'',
				'The room’s creator and co-owners pay nothing: the client asks them `Price` 0 (the',
				'listed price is accepted too).',
				'',
				'`GiftRecipientAccountId` sends what is bought to that player; the buyer still pays.',
				'Null (or the buyer’s own id) keeps it. Either way the items are added to the',
				'recipient’s `room_inventory`.',
				'',
				'Answers the client’s purchase result, observed from the live client:',
				'`BalanceUpdateResult` (an UpdateResponse — 0 OK), `CurrencyBalanceResponse` (what',
				'the BUYER now holds of what they paid in: `{ AccountId, CurrencyId, Balance,',
				'ModifiedAt }`, `CurrencyId` null and `Balance` their token total for a token',
				'listing) and `OperationResult` — `{ Status, InventoryItem }`, the item being what',
				'the RECIPIENT now owns — the same `RoomConsumableInventoryItem` that',
				'`…/roomConsumable/room/{roomId}/me` lists: `Count` the resulting total,',
				'`ConcurrencyCode` the request’s `NewConcurrencyCode` (stored, not checked),',
				'`Consumable` the listing plus `IsGiftable`/`Visibility`.',
				'',
				'A refusal is a 200 in the same shape — `Status` 1, a null `InventoryItem`, the',
				'balance as it stands — with the reason in `BalanceUpdateResult`: 4 no such',
				'consumable or room, 7 a bad `Quantity`, 8 a bad gift recipient, 6 a price or',
				'currency that is not the listing’s, 2 not enough to pay. Nothing is charged or',
				'given. The refusal form is an ASSUMPTION — only success has been observed.',
			].join('\n'),
			security: AUTHED,
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'The consumable to buy — a `room_consumable` id',
					schema: { type: 'string' },
				},
				{
					name: 'via',
					in: 'path',
					required: true,
					description: '`tokens` for a listing priced in tokens, `currency` for a room currency',
					schema: { type: 'string', enum: ['tokens', 'currency'] },
				},
			],
			requestBody: jsonBody(PurchaseRoomConsumableRequest, 'What to buy, and what the client saw'),
			responses: {
				200: json(PurchaseRoomConsumableResponse, 'What the recipient now owns, or a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			const currencyType = CurrencyType.RecCenterTokens
			const body = await c.req
				.json<{
					ConcurrencyCodes?: { NewConcurrencyCode?: unknown } | null
					ExpectedPriceAndCurrency?: { Price?: unknown; CurrencyId?: unknown } | null
					Quantity?: unknown
					GiftRecipientAccountId?: unknown
				}>()
				.catch(() => null)
			const request = body !== null && typeof body === 'object' ? body : {}
			const expected = request.ExpectedPriceAndCurrency
			const expectedCurrency =
				typeof expected?.CurrencyId === 'string' && expected.CurrencyId !== ''
					? expected.CurrencyId
					: null
			const consumable = await getRoomConsumable(c.env.DB, c.req.param('id'))
			// The balance the answer reports on: what the listing is priced in once it is known,
			// what the request named on a refusal that never got that far. Null is tokens.
			const balanceCurrency = consumable ? consumable.PurchaseCurrencyId : expectedCurrency

			// Every key is always sent: the client reads an omitted `Status` or
			// `BalanceUpdateResult` as its enum's 0 member, which is success.
			const answer = async (code: number, item: RoomConsumableInventoryItem | null) =>
				c.json({
					BalanceUpdateResult: code,
					CurrencyBalanceResponse: {
						AccountId: id,
						CurrencyId: balanceCurrency,
						Balance:
							balanceCurrency === null
								? await getBalance(c.env.DB, id, currencyType, startingTokens)
								: await getRoomBalance(c.env.DB, balanceCurrency, id),
						ModifiedAt: new Date().toISOString(),
					},
					OperationResult: {
						Status: item === null ? ROOM_KEY_STATUS_FAILED : ROOM_KEY_STATUS_OK,
						InventoryItem: item,
					},
				})

			if (!consumable) return answer(UpdateResponse.NoItemAvailable, null)

			const quantity = request.Quantity
			if (
				typeof quantity !== 'number' ||
				!Number.isInteger(quantity) ||
				quantity < 1 ||
				(consumable.MaximumCountPerPurchase > 0 && quantity > consumable.MaximumCountPerPurchase)
			) {
				return answer(UpdateResponse.RequestedAmountNotAllowed, null)
			}

			const gift = request.GiftRecipientAccountId
			if (
				gift !== null &&
				gift !== undefined &&
				!(Number.isInteger(gift) && (gift as number) > 0)
			) {
				return answer(UpdateResponse.PlayerNotEligible, null)
			}
			const recipientId = (gift as number | null | undefined) ?? id

			// Paid in the listing's own currency only — never whichever the request would rather.
			if (expectedCurrency?.toLowerCase() !== consumable.PurchaseCurrencyId?.toLowerCase()) {
				return answer(UpdateResponse.RequestedPriceDoesNotMatch, null)
			}

			const canManage = await canManageRoomById(c.env.DB, consumable.RoomId, id)
			if (canManage === null) return answer(UpdateResponse.NoItemAvailable, null)
			const expectedPrice = expected?.Price
			if (expectedPrice !== consumable.Price && !(canManage && expectedPrice === 0)) {
				return answer(UpdateResponse.RequestedPriceDoesNotMatch, null)
			}

			const total = canManage ? 0 : consumable.Price * quantity
			if (total > 0 && consumable.PurchaseCurrencyId !== null) {
				if (!(await spendRoomCurrency(c.env.DB, consumable.PurchaseCurrencyId, id, total))) {
					return answer(UpdateResponse.NotEnoughCredit, null)
				}
			} else if (total > 0) {
				const ownerId = await getRoomOwnerId(c.env.DB, consumable.RoomId)
				if (ownerId === null) return answer(UpdateResponse.NoItemAvailable, null)
				if (!(await spendCurrency(c.env.DB, id, currencyType, total, startingTokens))) {
					return answer(UpdateResponse.NotEnoughCredit, null)
				}
				// Seed the owner's signup grant BEFORE crediting them, as the key sale does.
				await ensureStartingBalances(c.env.DB, ownerId, startingTokens)
				const ownerBalance = await creditCurrency(
					c.env.DB,
					ownerId,
					currencyType,
					total,
					startingTokens
				)
				await pushBalanceUpdate(c, ownerId, currencyType, ownerBalance)
				await pushBalancePurchase(
					c,
					id,
					currencyType,
					-total,
					await getBalance(c.env.DB, id, currencyType, startingTokens)
				)
			}

			const newCode = request.ConcurrencyCodes?.NewConcurrencyCode
			const owned = await awardRoomConsumable(
				c.env.DB,
				recipientId,
				consumable.RoomConsumableId,
				quantity,
				typeof newCode === 'string' ? newCode : null
			)
			return answer(UpdateResponse.OK, toInventoryItem(recipientId, owned, consumable))
		}
	)

	// Create a consumable, or replace one when the body names an existing id. Auth-gated (401)
	// and gated to the room's creator or a co-owner (403) — a shop is the room's to stock.
	.put(
		'/api/roomconsumables/v1/roomConsumable',
		describeRoute({
			tags: ['Econ'],
			summary: 'Create or replace a room consumable',
			description: [
				'Puts a thing in the room’s shop. JSON, with the price nested:',
				'`{ "RoomConsumableId": null, "RoomId": 1162, "Name": "…", "Description": "…",',
				'"ImageName": null, "PriceAndCurrency": { "Price": 50, "CurrencyId": "…" } }`.',
				'',
				'`RoomConsumableId` null (or absent) CREATES a listing and mints its id; naming an',
				'existing listing REPLACES it. A replace is a replace, not a merge — the client',
				'sends the whole form back, so an absent field is a cleared one. (The currency edit',
				'is the opposite: its body is genuinely partial.)',
				'',
				'On a create the room is the body’s `RoomId`. On a replace it is the STORED',
				'listing’s, and the body’s is ignored — an edit cannot move a listing into another',
				'room, and the permission check must not be pointed somewhere friendlier than where',
				'the thing actually lives.',
				'',
				'Gated to the room’s creator or a co-owner; a valid token from anyone else is a 403.',
				'A listing priced in TOKENS (`CurrencyId` null) at a non-zero price also needs Rec',
				'Room Plus (the token’s `rn.plus` claim), on a create or a replace; without it, 403.',
				'`PriceAndCurrency` is collapsed into the flat `Price`/`PurchaseCurrencyId` the read',
				'serves. Answers the `{ Value, Success, Error, error_id }` envelope the room-currency',
				'writes use, or a 200 carrying `Success: false` when the body is unusable or the',
				'listing is unknown.',
			].join('\n'),
			security: AUTHED,
			requestBody: jsonBody(UpsertRoomConsumableRequest, 'The listing to create or replace'),
			responses: {
				200: json(
					RoomConsumableEnvelope,
					'The listing as stored, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description:
						'Not the room’s creator or a co-owner, or a token price without Rec Room Plus (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as Record<
				string,
				unknown
			> | null
			if (!body) return roomConsumableEnvelope(c, null, SAVE_CONSUMABLE_FAILED)

			const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
			const int = (v: unknown, fallback: number): number =>
				typeof v === 'number' && Number.isInteger(v) ? v : fallback

			const name = str(body.Name)?.trim() ?? ''
			if (name === '') return roomConsumableEnvelope(c, null, SAVE_CONSUMABLE_FAILED)

			// On a replace the room comes off the STORED listing, never the body — the same rule
			// the currency edit follows. Otherwise a caller could name a listing in one room and
			// a room they happen to own, and have the check pass against the wrong one.
			const roomConsumableId = str(body.RoomConsumableId)
			let roomId: number
			if (roomConsumableId === null) {
				roomId = int(body.RoomId, Number.NaN)
				if (!Number.isInteger(roomId)) {
					return roomConsumableEnvelope(c, null, SAVE_CONSUMABLE_FAILED)
				}
			} else {
				const existing = await getRoomConsumable(c.env.DB, roomConsumableId)
				if (!existing) return roomConsumableEnvelope(c, null, SAVE_CONSUMABLE_FAILED)
				roomId = existing.RoomId
			}

			const canManage = await canManageRoomById(c.env.DB, roomId, accountId)
			if (canManage === null) return roomConsumableEnvelope(c, null, SAVE_CONSUMABLE_FAILED)
			if (!canManage) return c.body(null, 403)

			// One price in one currency, flattened out of the body's nested object.
			const priceAndCurrency = (
				typeof body.PriceAndCurrency === 'object' && body.PriceAndCurrency !== null
					? body.PriceAndCurrency
					: {}
			) as Record<string, unknown>

			const price = int(priceAndCurrency.Price, 0)
			const purchaseCurrencyId = str(priceAndCurrency.CurrencyId)
			// Selling for TOKENS is a Rec Room Plus perk (see `isSubscriber`); a listing in the
			// room's own currency, or a free one, is open to every room manager. Checked on a
			// replace too, so an edit can't turn a currency listing into a token one.
			if (purchaseCurrencyId === null && price !== 0 && !(await isSubscriber(c))) {
				return c.body(null, 403)
			}

			const consumable = await upsertRoomConsumable(c.env.DB, roomConsumableId, {
				RoomId: roomId,
				// Masked like every other player-typed string: a shop's contents are shown to
				// everyone who walks into the room.
				Name: censorSwears(name),
				Description: censorSwears(str(body.Description) ?? ''),
				ImageName: str(body.ImageName),
				Price: price,
				PurchaseCurrencyId: purchaseCurrencyId,
				// The client has not been seen sending this, so it falls back to the CLR default
				// for an int rather than to a guess at what the shop should allow.
				MaximumCountPerPurchase: int(body.MaximumCountPerPurchase, 0),
			})
			return roomConsumableEnvelope(c, consumable)
		}
	)
	// What the CALLER owns of one room's consumables. NOT the catalogue the same path without
	// `/me` serves: a different element type (`RoomConsumableInventoryItem`), so a separate handler.
	.get(
		'/api/roomconsumables/v1/roomConsumable/room/:roomId/me',
		describeRoute({
			tags: ['Econ'],
			summary: 'The caller’s room consumables',
			description: [
				'A bare array of what the caller owns of the room’s consumables, in the shop’s order —',
				'the client’s `RoomConsumableInventoryItem`, observed from the live client:',
				'`{ RoomConsumableId, AccountId, Count, ConcurrencyCode, ModifiedAt, Consumable }`.',
				'',
				'`Count` is what they hold now; a consumable they hold none of (never had, or spent',
				'down to zero) is absent. `ConcurrencyCode` is the last `NewConcurrencyCode` written',
				'(stored, not checked). `Consumable` is the listing plus `IsGiftable` (false) and',
				'`Visibility` (0), with `ImageName` as "" rather than null — NOT the catalogue',
				'element `…/room/{roomId}` serves.',
				'',
				'An unknown room, or one the caller owns nothing of, is an empty list.',
			].join('\n'),
			security: AUTHED,
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					description: 'The room whose consumables to list',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(RoomConsumableInventoryItemDto.array(), 'What the caller owns, shop order'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			if (!Number.isInteger(roomId)) return c.json([])
			return c.json(await getRoomInventory(c.env.DB, roomId, id))
		}
	)
	// Use up one of a room consumable the CALLER holds — drinking the Health Potion. Auth-gated
	// (401); a refusal is a 200 in the same shape, as the purchase's is.
	.put(
		'/api/roomconsumables/v1/roomConsumable/:id/consume',
		describeRoute({
			tags: ['Econ'],
			summary: 'Consume a room consumable',
			description: [
				'Takes ONE of the consumable named in the path from what the caller holds. The body',
				'is only `{ CurrentConcurrencyCode, NewConcurrencyCode }`, at the top level; there is',
				'no quantity. `NewConcurrencyCode` is stored and served back as the item’s',
				'`ConcurrencyCode`; `CurrentConcurrencyCode` is accepted and NOT checked.',
				'',
				'Answers `{ Status, InventoryItem }` — the purchase’s `OperationResult` — with the',
				'`RoomConsumableInventoryItem` the caller now holds: `Count` the RESULTING total, 0',
				'when they used their last (after which `…/room/{roomId}/me` omits it).',
				'',
				'A consumable that does not exist, or one the caller holds none of, is `Status` 1',
				'with a null `InventoryItem`, and nothing is written. The refusal form is an',
				'ASSUMPTION — only success has been observed.',
			].join('\n'),
			security: AUTHED,
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'The consumable to use — a `room_consumable` id',
					schema: { type: 'string' },
				},
			],
			requestBody: jsonBody(ConsumeRoomConsumableRequest, 'The concurrency pair'),
			responses: {
				200: json(ConsumeRoomConsumableResponse, 'What the caller now holds, or a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = await c.req.json<{ NewConcurrencyCode?: unknown }>().catch(() => null)
			const newCode =
				body !== null && typeof body === 'object' && typeof body.NewConcurrencyCode === 'string'
					? body.NewConcurrencyCode
					: null
			// Every key is always sent: an omitted `Status` reads as its enum's 0, success.
			const refused = () => c.json({ Status: ROOM_KEY_STATUS_FAILED, InventoryItem: null })

			const consumable = await getRoomConsumable(c.env.DB, c.req.param('id'))
			if (!consumable) return refused()
			const held = await consumeRoomConsumable(c.env.DB, id, consumable.RoomConsumableId, newCode)
			if (!held) return refused()
			return c.json({
				Status: ROOM_KEY_STATUS_OK,
				InventoryItem: toInventoryItem(id, held, consumable),
			})
		}
	)
	// The custom currencies a room has minted. Public, like the room itself: a room's
	// currencies are shown to every player who walks into it, so the list is not a secret
	// the way its ban list is. A room with none — or an unknown room — is an empty list.
	.get(
		'/api/roomcurrencies/v1/currencies',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s currencies',
			description: [
				'Every custom currency the room named by `roomId` has minted, oldest first — the',
				'order its owner built them up in.',
				'',
				'Public, like the room itself: a room’s currencies are shown to everyone who walks',
				'into it. A room with none, an unknown room, and a missing `roomId` are all the same',
				'empty list, which the client reads as "this room has no currency of its own".',
				'',
				'These are DEFINITIONS, not balances — what a player holds of one is',
				'`getAllBalances`, which is still a stub.',
			].join('\n'),
			parameters: [
				{
					name: 'roomId',
					in: 'query',
					required: false,
					description: 'The room whose currencies to list',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(RoomCurrencyDto.array(), 'The room’s currencies, oldest first') },
		}),
		async (c) => {
			const roomId = Number.parseInt(c.req.query('roomId') ?? '', 10)
			if (!Number.isInteger(roomId)) return c.json([])
			return c.json(await getRoomCurrencies(c.env.DB, roomId))
		}
	)

	// Mint a custom currency for a room. Auth-gated (401) and gated to the room's creator or
	// a co-owner (403) — the same owner-level check the `rooms` worker applies to its own
	// room-admin writes, reading the same room blob.
	.post(
		'/api/roomcurrencies/v1/createCurrency',
		describeRoute({
			tags: ['Econ'],
			summary: 'Create a room currency',
			description: [
				'Mints a custom currency for one room — its name, its description, its coin art and',
				'the most of it the room may award per day. Form-encoded',
				'(`RoomId=2511&Name=Devintokens&Description=…&Limit=100&Shape=0&Color=19`).',
				'',
				'Gated to the room’s CREATOR or a CO-OWNER — minting a currency is room',
				'administration, so it takes the same standing as the room’s other settings. A valid',
				'token from anyone else is a 403.',
				'',
				'`Name` and `Description` are masked by the same word list as every other string a',
				'player types, since a currency’s name is shown to everyone in the room.',
				'',
				'Answers the created currency inside the `{ Value, Success, Error, error_id }`',
				'envelope — PascalCase beside a lowercase `error_id`, which is the client’s own mixed',
				'casing. The client unwraps it and hands its callers `Value` alone. A recoverable',
				'refusal (an unusable `RoomId`, an empty `Name`, an unknown room) is a 200 carrying',
				'`Success: false`, a null `Value` and the reference’s own message; only the auth',
				'gates answer with a status of their own.',
				'',
				'`CurrencyId` is how the client names this currency everywhere afterwards.',
				'`CurrencyType` is always 300 (RoomCurrency) and `ImageName` is null until custom',
				'coin art can be uploaded.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(CreateRoomCurrencyRequest, 'The currency to mint'),
			responses: {
				200: json(
					RoomCurrencyEnvelope,
					'The currency as created, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the room’s creator or a co-owner (empty body)' },
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v : '')
			const int = (v: unknown, fallback: number): number => {
				const parsed = Number.parseInt(str(v), 10)
				return Number.isInteger(parsed) ? parsed : fallback
			}

			const roomId = int(body.RoomId, Number.NaN)
			if (!Number.isInteger(roomId)) return roomCurrencyEnvelope(c, null, CREATE_CURRENCY_FAILED)
			const name = str(body.Name).trim()
			if (name === '') return roomCurrencyEnvelope(c, null, CREATE_CURRENCY_FAILED)

			// The room is the `rooms` worker's, read here only to apply its owner check — the
			// same `canManageRoom` that worker gates its own room-admin writes on, so the two
			// can't drift into disagreeing about who runs a room. Null is no such room, which
			// answers differently from a room somebody else runs.
			const canManage = await canManageRoomById(c.env.DB, roomId, accountId)
			if (canManage === null) return roomCurrencyEnvelope(c, null, CREATE_CURRENCY_FAILED)
			if (!canManage) return c.body(null, 403)

			const currency = await createRoomCurrency(c.env.DB, {
				RoomId: roomId,
				// Masked like every other player-typed string (see the gift note above): a
				// currency's name is shown to everyone who walks into the room.
				Name: censorSwears(name),
				Description: censorSwears(str(body.Description)),
				Limit: int(body.Limit, 0),
				Shape: int(body.Shape, 0),
				Color: int(body.Color, 0),
			})

			await pushRoomCurrencyChange(c, currency, accountId, NotificationType.RoomCurrencyCreated)
			return roomCurrencyEnvelope(c, currency)
		}
	)

	// Edit a room currency. Auth-gated (401) and gated to the creator or a co-owner of the room
	// that MINTED it (403) — the currency names the room, so the caller doesn't get to say
	// which room's permissions apply. Answers the same envelope the create does.
	.post(
		'/api/roomcurrencies/v1/updateCurrency',
		describeRoute({
			tags: ['Econ'],
			summary: 'Edit a room currency',
			description: [
				'Changes a currency’s name, description, daily award limit or coin art. Form-encoded,',
				'naming the',
				'currency by `CurrencyId`',
				'(`CurrencyId=b9f41a7c-\u2026&Name=\u2026&Description=\u2026&Limit=330&Shape=9&Color=5`).',
				'',
				'The room is not in the body and cannot be: it is whichever room minted the currency,',
				'which is also the room whose creator/co-owner check applies. A valid token from',
				'anyone else is a 403.',
				'',
				'Every field but `CurrencyId` is optional, and one left out is left ALONE rather than',
				'reset — the client sends the whole form, so this only bites a partial request, and',
				'blanking a description because it went unmentioned is the worse reading. What can',
				'never change: the id, the room, the `CurrencyType`, and `CreatedAt`. `ModifiedAt`',
				'moves to now, which is what the client’s model carries both for.',
				'',
				'`Name` and `Description` are masked by the same word list as every other string a',
				'player types. Answers the created-currency envelope: the updated currency in',
				'`Value`, or a 200 carrying `Success: false` when there is no such currency or the',
				'body is unusable.',
				'',
				'Everyone standing in the room gets a `RoomCurrencyModified` frame — a renamed or',
				'recapped currency that only the editor hears about leaves the rest of the room',
				'spending the old one.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(UpdateRoomCurrencyRequest, 'The currency and the fields to change'),
			responses: {
				200: json(
					RoomCurrencyEnvelope,
					'The currency as it now stands, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description: 'Not the creator or a co-owner of the room that minted it (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
			const int = (v: unknown): number | undefined => {
				const raw = str(v)
				if (raw === undefined) return undefined
				const parsed = Number.parseInt(raw, 10)
				return Number.isInteger(parsed) ? parsed : undefined
			}

			const currencyId = str(body.CurrencyId)?.trim() ?? ''
			if (currencyId === '') return roomCurrencyEnvelope(c, null, UPDATE_CURRENCY_FAILED)

			const existing = await getRoomCurrency(c.env.DB, currencyId)
			if (!existing) return roomCurrencyEnvelope(c, null, UPDATE_CURRENCY_FAILED)

			// The room comes off the CURRENCY, never the request: the caller names what to edit,
			// not whose permissions to check against. Same gate as minting one.
			const canManage = await canManageRoomById(c.env.DB, existing.RoomId, accountId)
			// A currency whose room has since been deleted is unowned and so uneditable by
			// anyone — a rejection rather than a 403, since nobody is being turned away.
			if (canManage === null) return roomCurrencyEnvelope(c, null, UPDATE_CURRENCY_FAILED)
			if (!canManage) return c.body(null, 403)

			// A name sent but blank is a bad edit, not an instruction to leave it alone: the
			// currency would be left nameless in every list that shows it.
			const name = str(body.Name)?.trim()
			if (name !== undefined && name === '') {
				return roomCurrencyEnvelope(c, null, UPDATE_CURRENCY_FAILED)
			}

			const updated = await updateRoomCurrency(c.env.DB, existing, {
				Name: name === undefined ? undefined : censorSwears(name),
				Description:
					str(body.Description) === undefined ? undefined : censorSwears(str(body.Description)!),
				Limit: int(body.Limit),
				Shape: int(body.Shape),
				Color: int(body.Color),
			})

			await pushRoomCurrencyChange(c, updated, accountId, NotificationType.RoomCurrencyModified)
			return roomCurrencyEnvelope(c, updated)
		}
	)

	// The purchase offers on one or more room currencies — a currency's shop, the ways a
	// player can BUY it. Public, like the currencies themselves: a shop is shown to everyone
	// who walks into the room.
	.get(
		'/api/roomcurrencies/v1/getPurchaseOffersBatch',
		describeRoute({
			tags: ['Econ'],
			summary: 'Purchase offers for room currencies',
			description: [
				'The offers on each currency named in `ids` — the ways a player can buy that',
				'currency, priced in another ("5 SuperTokens for 500 Rec Center Tokens").',
				'',
				'`ids` takes several currencies: comma-separated, repeated (`ids=a&ids=b`), or both.',
				'The answer is one GROUP per currency — `{ CurrencyId, PurchaseOffers }` — in the',
				'order the ids were given, each shop sorted by its offers’ `Order`. Grouped even',
				'though every offer carries its own `CurrencyId`, because the group is what says a',
				'currency was asked about: a currency with no shop still gets one, with an empty',
				'`PurchaseOffers`.',
				'',
				'An id naming no currency at all is omitted — there is no shop to report, empty or',
				'otherwise — the way the other batch lookups here treat an unknown id, and never an',
				'error for the whole call. No `ids` at all is an empty list.',
				'',
				'Public, like `GET /api/roomcurrencies/v1/currencies`. Nothing writes offers yet, so',
				'every currency answers empty until there is an endpoint that builds a shop.',
			].join('\n'),
			parameters: [
				{
					name: 'ids',
					in: 'query',
					required: false,
					description: 'Currency ids — comma-separated, repeated, or both',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(
					RoomCurrencyPurchaseOffersDto.array(),
					'One group per currency asked for, in the order given'
				),
			},
		}),
		async (c) => {
			// Both spellings, since nothing says which the client uses: `ids=a&ids=b` and
			// `ids=a,b` reach the same list, and blanks from a trailing comma are dropped.
			const ids = c.req
				.queries('ids')
				?.flatMap((value) => value.split(','))
				.map((value) => value.trim())
				.filter((value) => value !== '')

			// De-duplicated: an id sent twice is one shop, not the same shop twice.
			return c.json(await getPurchaseOffers(c.env.DB, [...new Set(ids ?? [])]))
		}
	)

	// Add a purchase offer to a room currency's shop. Auth-gated (401) and gated to the
	// creator or a co-owner of the room that minted the currency (403) — a shop is the room's
	// to build, and the room comes off the currency rather than the request.
	.post(
		'/api/roomcurrencies/v1/createPurchaseOffer',
		describeRoute({
			tags: ['Econ'],
			summary: 'Add a purchase offer to a room currency',
			description: [
				'Appends an offer to the currency named by `CurrencyId` — a way for players to buy',
				'that currency ("5 SuperTokens for 500 Rec Center Tokens"). Form-encoded',
				'(`CurrencyId=…&Name=…&Amount=5&Price=55&Order=0`).',
				'',
				'Note `Amount` in the body against `CurrencyAmount` on the offer it becomes: the',
				'body and the client’s model spell the same number differently, and the answer uses',
				'the model’s spelling.',
				'',
				'`CurrencyPurchaseOfferId` and `ModifiedAt` are minted here — the offer’s id is how',
				'the client names it afterwards. `Order` places it in the shop and defaults to 0;',
				'offers are served sorted by it, so several at 0 keep the order they were added in.',
				'',
				'Gated to the creator or a co-owner of the room that minted the currency. A valid',
				'token from anyone else is a 403, and so is a non-zero `Price` without Rec Room Plus',
				'(the token’s `rn.plus` claim) — the offer is paid in tokens. Answers the same',
				'`{ Value, Success, Error, error_id }` envelope the currency writes use, with the',
				'offer in `Value`, or a 200 carrying `Success: false` when the currency is unknown',
				'or the body unusable.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(CreatePurchaseOfferRequest, 'The offer to add'),
			responses: {
				200: json(
					RoomCurrencyPurchaseOfferEnvelope,
					'The offer as created, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description:
						'Not the creator or a co-owner of the minting room, or a priced offer without Rec Room Plus (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v : '')
			const int = (v: unknown, fallback: number): number => {
				const parsed = Number.parseInt(str(v), 10)
				return Number.isInteger(parsed) ? parsed : fallback
			}

			const currencyId = str(body.CurrencyId).trim()
			if (currencyId === '') return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)

			const amount = int(body.Amount, Number.NaN)
			const price = int(body.Price, Number.NaN)
			if (!Number.isInteger(amount) || !Number.isInteger(price)) {
				return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)
			}

			const currency = await getRoomCurrency(c.env.DB, currencyId)
			if (!currency) return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)

			// The room comes off the CURRENCY, never the request — the same gate minting and
			// editing one take. A shop is the room's to build.
			const canManage = await canManageRoomById(c.env.DB, currency.RoomId, accountId)
			if (canManage === null) return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)
			if (!canManage) return c.body(null, 403)
			// An offer sells the currency for TOKENS, which is a Rec Room Plus perk (see
			// `isSubscriber`). A free offer moves no tokens, so any room manager may make one.
			if (price !== 0 && !(await isSubscriber(c))) return c.body(null, 403)

			const offer = await createPurchaseOffer(c.env.DB, currencyId, {
				// The body's `Amount` is the model's `CurrencyAmount`.
				CurrencyAmount: amount,
				Price: price,
				// Stored verbatim, NOT profanity-masked like a currency's name: the client has
				// been seen sending a GUID here, and the mask works on substrings — it would
				// happily corrupt an identifier that happened to contain a word. If this turns
				// out to be player-typed display text, it wants masking.
				Name: str(body.Name),
				Order: int(body.Order, 0),
			})
			return purchaseOfferEnvelope(c, offer)
		}
	)

	// Take a purchase offer down. Auth-gated (401) and gated to the creator or a co-owner of
	// the room that minted the currency the offer sells (403). The body names ONLY the offer,
	// so the currency — and through it the room — is found by walking the shops for the id;
	// nothing about the caller's whereabouts is consulted.
	.post(
		'/api/roomcurrencies/v1/deletePurchaseOffer',
		describeRoute({
			tags: ['Econ'],
			summary: 'Remove a purchase offer from a room currency',
			description: [
				'Removes the offer named by `PurchaseOfferId` (its `CurrencyPurchaseOfferId`) from',
				'whichever currency’s shop lists it. Form-encoded (`PurchaseOfferId=…`). The body',
				'names nothing else: the currency, and the room that gates the delete, are found',
				'from the offer.',
				'',
				'Gated to the creator or a co-owner of the room that minted the currency. A valid',
				'token from anyone else is a 403. Answers the same',
				'`{ Value, Success, Error, error_id }` envelope the create answers in, with the',
				'offer as it stood when removed in `Value`, or a 200 carrying `Success: false` when',
				'no shop lists that id. What the client does with `Value` here is an assumption —',
				'only the create’s reply has been observed.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(DeletePurchaseOfferRequest, 'The offer to remove'),
			responses: {
				200: json(
					RoomCurrencyPurchaseOfferEnvelope,
					'The offer as removed, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: { description: 'Not the creator or a co-owner of the minting room (empty body)' },
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const purchaseOfferId = (
				typeof body.PurchaseOfferId === 'string' ? body.PurchaseOfferId : ''
			).trim()
			if (purchaseOfferId === '') return purchaseOfferEnvelope(c, null, DELETE_OFFER_FAILED)

			// Found BEFORE it is removed, because the find is what says which room gates the
			// delete: an unknown id is a refusal, and a known one is somebody's to refuse.
			const found = await findPurchaseOffer(c.env.DB, purchaseOfferId)
			if (!found) return purchaseOfferEnvelope(c, null, DELETE_OFFER_FAILED)

			const canManage = await canManageRoomById(c.env.DB, found.RoomId, accountId)
			if (canManage === null) return purchaseOfferEnvelope(c, null, DELETE_OFFER_FAILED)
			if (!canManage) return c.body(null, 403)

			const removed = await deletePurchaseOffer(c.env.DB, purchaseOfferId)
			if (!removed) return purchaseOfferEnvelope(c, null, DELETE_OFFER_FAILED)
			return purchaseOfferEnvelope(c, removed.Offer)
		}
	)

	// Award room currency to players, several awards per call. Auth-gated (401); everything
	// else is reported PER ENTRY, including whether the caller may award that currency at all.
	.post(
		'/api/roomcurrencies/v1/awardCurrency/bulk',
		describeRoute({
			tags: ['Econ'],
			summary: 'Award room currency in bulk',
			description: [
				'Adds to what players hold of a room currency. The body is a JSON ARRAY, each entry',
				'naming its own `CurrencyId` and `RecipientId`, so one call can pay several players',
				'or one player in several currencies.',
				'',
				'The answer is a BARE ARRAY, one result per entry IN THE ORDER SENT, and each result',
				'stands alone: `Success` and `Error` are that entry’s, and `Response` carries the',
				'outcome or is null. So one entry failing neither fails the others nor the call —',
				'including an entry whose currency belongs to a room the caller cannot manage, which',
				'is that entry’s failure rather than a 403 for everything. Only a missing or invalid',
				'token is answered at the call level, with a 401.',
				'',
				'Each entry is authorised against the room that MINTED its currency: the caller must',
				'be that room’s creator or a co-owner. The room comes off the currency, never the',
				'request — a faucet a caller could point at any room would let anyone print another',
				'room’s money.',
				'',
				'`Amount` may be negative, which deducts. A balance floors at zero in the write',
				'itself — a player cannot owe a room currency — and `AmountAwarded` reports what',
				'actually landed, which is less than was asked for only when a deduction ran out of',
				'balance to take. `Balance` is the RESULTING total.',
				'',
				'The currency’s `Limit` is NOT applied here. It is the most a room may award PER DAY',
				'— a faucet rate, not a ceiling on holdings — and nothing tracks a day’s awards yet,',
				'so no award is refused for it.',
				'',
				'`TransactionId` is the client’s id for an award so that a retry is the same award.',
				'It is accepted and validated, but NOT yet deduplicated — replaying a request',
				'currently awards twice. That needs a table of its own.',
			].join('\n'),
			security: AUTHED,
			requestBody: jsonBody(
				AwardRoomCurrencyRequest.array(),
				'The awards to apply, as a bare JSON array'
			),
			responses: {
				200: json(AwardRoomCurrencyResultList, 'One result per entry, in the order sent'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const parsed = await c.req.json<unknown>().catch(() => null)
			// A body that isn't a list of awards has no entries to report on, and the answer is
			// a list of entry results — so there is nothing to say but "none".
			if (!Array.isArray(parsed)) return c.json([])

			// Cached across entries, so paying twenty players in one currency is one currency
			// lookup and one permission check rather than twenty of each. `null` caches a
			// currency that doesn't exist; `false` one the caller may not award.
			const currencies = new Map<string, RoomCurrency | null | false>()
			const resolve = async (currencyId: string): Promise<RoomCurrency | null | false> => {
				const cached = currencies.get(currencyId)
				if (cached !== undefined) return cached

				const found = await getRoomCurrency(c.env.DB, currencyId)
				// The room comes off the CURRENCY, never the request — the same gate minting and
				// editing one take.
				const canManage = found && (await canManageRoomById(c.env.DB, found.RoomId, accountId))
				const resolved = !found || canManage === null ? null : canManage ? found : false
				currencies.set(currencyId, resolved)
				return resolved
			}

			const results = []
			for (const entry of parsed as Array<Record<string, unknown>>) {
				const currencyId = typeof entry?.CurrencyId === 'string' ? entry.CurrencyId.trim() : ''
				const playerId = Number(entry?.RecipientId)
				const amount = Number(entry?.Amount)

				// Every result names its entry even when the entry was unusable, so a caller can
				// line the answer up with what it sent.
				const fail = (error: string) => ({
					AccountId: Number.isInteger(playerId) ? playerId : 0,
					CurrencyId: currencyId,
					Success: false,
					Error: error,
					Response: null,
				})

				if (currencyId === '' || !Number.isInteger(playerId) || !Number.isInteger(amount)) {
					results.push(fail('Invalid award'))
					continue
				}

				const currency = await resolve(currencyId)
				if (currency === null) {
					results.push(fail('No such currency'))
					continue
				}
				if (currency === false) {
					results.push(fail('Not permitted'))
					continue
				}

				const { Balance, AmountAwarded } = await awardRoomCurrency(
					c.env.DB,
					currency.CurrencyId,
					playerId,
					amount
				)
				results.push({
					AccountId: playerId,
					CurrencyId: currency.CurrencyId,
					Success: true,
					Error: null,
					Response: {
						AccountId: playerId,
						CurrencyId: currency.CurrencyId,
						Balance,
						AmountAwarded,
						AwardedAt: new Date().toISOString(),
					},
				})
			}

			return c.json(results)
		}
	)

	// The purchase offers on one or more room currencies — a currency's shop, the ways a
	// player can BUY it. Public, like the currencies themselves: a shop is shown to everyone
	// who walks into the room.
	.get(
		'/api/roomcurrencies/v1/getPurchaseOffersBatch',
		describeRoute({
			tags: ['Econ'],
			summary: 'Purchase offers for room currencies',
			description: [
				'The offers on each currency named in `ids` — the ways a player can buy that',
				'currency, priced in another ("5 SuperTokens for 500 Rec Center Tokens").',
				'',
				'`ids` takes several currencies: comma-separated, repeated (`ids=a&ids=b`), or both.',
				'The answer is FLAT rather than grouped, because every offer carries its own',
				'`CurrencyId` — the client groups them itself, and one currency’s answer looks like',
				'twenty’s. Ordered by the ids as given, then by each offer’s `Order`, so a caller',
				'gets its own batch back in its own order with each shop in shop order.',
				'',
				'An id naming no currency contributes nothing, the way the other batch lookups here',
				'treat an unknown id: a shop that does not exist is an empty one, not an error for',
				'the whole call. No `ids` at all is an empty list.',
				'',
				'Public, like `GET /api/roomcurrencies/v1/currencies`. Nothing writes offers yet, so',
				'every currency answers empty until there is an endpoint that builds a shop.',
			].join('\n'),
			parameters: [
				{
					name: 'ids',
					in: 'query',
					required: false,
					description: 'Currency ids — comma-separated, repeated, or both',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(
					RoomCurrencyPurchaseOfferDto.array(),
					'The offers, flattened across the currencies asked for'
				),
			},
		}),
		async (c) => {
			// Both spellings, since nothing says which the client uses: `ids=a&ids=b` and
			// `ids=a,b` reach the same list, and blanks from a trailing comma are dropped.
			const ids = c.req
				.queries('ids')
				?.flatMap((value) => value.split(','))
				.map((value) => value.trim())
				.filter((value) => value !== '')

			// De-duplicated: an id sent twice is one shop, not the same shop twice.
			return c.json(await getPurchaseOffers(c.env.DB, [...new Set(ids ?? [])]))
		}
	)

	// Add a purchase offer to a room currency's shop. Auth-gated (401) and gated to the
	// creator or a co-owner of the room that minted the currency (403) — a shop is the room's
	// to build, and the room comes off the currency rather than the request.
	.post(
		'/api/roomcurrencies/v1/createPurchaseOffer',
		describeRoute({
			tags: ['Econ'],
			summary: 'Add a purchase offer to a room currency',
			description: [
				'Appends an offer to the currency named by `CurrencyId` — a way for players to buy',
				'that currency ("5 SuperTokens for 500 Rec Center Tokens"). Form-encoded',
				'(`CurrencyId=…&Name=…&Amount=5&Price=55&Order=0`).',
				'',
				'Note `Amount` in the body against `CurrencyAmount` on the offer it becomes: the',
				'body and the client’s model spell the same number differently, and the answer uses',
				'the model’s spelling.',
				'',
				'`CurrencyPurchaseOfferId` and `ModifiedAt` are minted here — the offer’s id is how',
				'the client names it afterwards. `Order` places it in the shop and defaults to 0;',
				'offers are served sorted by it, so several at 0 keep the order they were added in.',
				'',
				'Gated to the creator or a co-owner of the room that minted the currency. A valid',
				'token from anyone else is a 403, and so is a non-zero `Price` without Rec Room Plus',
				'(the token’s `rn.plus` claim) — the offer is paid in tokens. Answers the same',
				'`{ Value, Success, Error, error_id }` envelope the currency writes use, with the',
				'offer in `Value`, or a 200 carrying `Success: false` when the currency is unknown',
				'or the body unusable.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(CreatePurchaseOfferRequest, 'The offer to add'),
			responses: {
				200: json(
					RoomCurrencyPurchaseOfferEnvelope,
					'The offer as created, or a rejection with `Success: false`'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description:
						'Not the creator or a co-owner of the minting room, or a priced offer without Rec Room Plus (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v : '')
			const int = (v: unknown, fallback: number): number => {
				const parsed = Number.parseInt(str(v), 10)
				return Number.isInteger(parsed) ? parsed : fallback
			}

			const currencyId = str(body.CurrencyId).trim()
			if (currencyId === '') return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)

			const amount = int(body.Amount, Number.NaN)
			const price = int(body.Price, Number.NaN)
			if (!Number.isInteger(amount) || !Number.isInteger(price)) {
				return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)
			}

			const currency = await getRoomCurrency(c.env.DB, currencyId)
			if (!currency) return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)

			// The room comes off the CURRENCY, never the request — the same gate minting and
			// editing one take. A shop is the room's to build.
			const canManage = await canManageRoomById(c.env.DB, currency.RoomId, accountId)
			if (canManage === null) return purchaseOfferEnvelope(c, null, CREATE_OFFER_FAILED)
			if (!canManage) return c.body(null, 403)
			// An offer sells the currency for TOKENS, which is a Rec Room Plus perk (see
			// `isSubscriber`). A free offer moves no tokens, so any room manager may make one.
			if (price !== 0 && !(await isSubscriber(c))) return c.body(null, 403)

			const offer = await createPurchaseOffer(c.env.DB, currencyId, {
				// The body's `Amount` is the model's `CurrencyAmount`.
				CurrencyAmount: amount,
				Price: price,
				// Stored verbatim, NOT profanity-masked like a currency's name: the client has
				// been seen sending a GUID here, and the mask works on substrings — it would
				// happily corrupt an identifier that happened to contain a word. If this turns
				// out to be player-typed display text, it wants masking.
				Name: str(body.Name),
				Order: int(body.Order, 0),
			})
			return purchaseOfferEnvelope(c, offer)
		}
	)
	.get('/api/roomcurrencies/v1/getAllBalances', listRoute('Room balances', 'Empty stub'), (c) =>
		c.json([])
	)

	// What one player holds of one room currency. Any signed-in caller may read any player's,
	// as the query names the player rather than taking the caller.
	.get(
		'/api/roomcurrencies/v1/getBalance',
		describeRoute({
			tags: ['Econ'],
			summary: 'A player’s balance of one room currency',
			description: [
				'What the player named by `accountId` holds of the room currency `currencyId`',
				'(`room_balance`). A player who has never earned any — and a currency that does not',
				'exist — is a `Balance` of 0, not a 404.',
				'',
				'`ModifiedAt` is the time of the response: `room_balance` keeps no modification time.',
				'A missing `currencyId` or a non-integer `accountId` is a 400.',
			].join('\n'),
			security: AUTHED,
			parameters: [
				{
					name: 'currencyId',
					in: 'query',
					required: true,
					description: 'The room currency',
					schema: { type: 'string' },
				},
				{
					name: 'accountId',
					in: 'query',
					required: true,
					description: 'The player whose balance to read',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(RoomCurrencyBalance, 'The player’s balance'),
				400: { description: 'A missing `currencyId` or a non-integer `accountId`' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			if ((await authedId(c)) === null) return unauthorized(c)
			const currencyId = c.req.query('currencyId')?.trim() ?? ''
			const rawAccountId = c.req.query('accountId')?.trim() ?? ''
			if (currencyId === '' || !/^\d+$/.test(rawAccountId)) return c.body(null, 400)
			const accountId = Number(rawAccountId)
			return c.json({
				AccountId: accountId,
				CurrencyId: currencyId,
				Balance: await getRoomBalance(c.env.DB, currencyId, accountId),
				ModifiedAt: new Date().toISOString(),
			})
		}
	)

	// Buy room currency with tokens, through one of the currency's purchase offers. The body
	// names only the OFFER — which currency it sells is whichever one lists it — and the
	// amount and price the client rendered, both of which must still match the offer.
	.post(
		'/api/roomCurrencies/v2/purchase',
		describeRoute({
			tags: ['Econ'],
			summary: 'Buy room currency with tokens',
			description: [
				'Buys from a room currency’s shop. Form-encoded',
				'(`PurchaseOfferId=ffab4157-…&RequestedAmount=444&RequestedPrice=555`): the caller',
				'pays the offer’s `Price` in RecCenterTokens and is given its `CurrencyAmount` of the',
				'currency the offer belongs to (`room_balance`).',
				'',
				'`PurchaseOfferId` is a `CurrencyPurchaseOfferId` out of a currency’s purchase offers,',
				'and is all that says which currency is bought. `RequestedAmount` and `RequestedPrice`',
				'must EQUAL the offer’s `CurrencyAmount` and `Price` — an offer edited since the client',
				'drew it is refused rather than sold at numbers the player did not see.',
				'',
				'The tokens are paid to the room’s OWNER (its `CreatorAccountId`), as a room-key sale',
				'is. The room’s owner and co-owners (the `canManageRoom` set) take from their own shop',
				'for free: the client shows them the offer at no cost and posts `RequestedPrice=0`, so',
				'their posted price is not checked and no tokens move. A free offer moves none either.',
				'',
				'Answers the `{ Value, Success, Error, error_id }` envelope the room-currency writes',
				'use. `Value` is BOTH balances the purchase moved, each a RESULTING total:',
				'`CurrencyBalanceResponse` (`AccountId`, `CurrencyId`, `Balance`, `ModifiedAt`) is',
				'what the buyer now holds of the room currency, and `TokenBalanceResponse`',
				'(`Balance`, `CurrencyType`, `Platform`) their tokens. `Platform` is -2, the one',
				'bucket every balance surface here names — any other value shows the buyer a phantom',
				'second token balance. A refusal (no such offer, a mismatch, not enough tokens) is a',
				'200 with `Success: false` and a null `Value` — that form is an assumption — and',
				'nothing moved.',
				'',
				'When tokens moved, both players get a socket push carrying their resulting token',
				'total — the buyer a StorefrontBalancePurchase, the owner a StorefrontBalanceUpdate.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(PurchaseRoomCurrencyRequest, 'The offer, and the numbers the client saw'),
			responses: {
				200: json(PurchaseRoomCurrencyEnvelope, 'The buyer’s new holding, or a refusal'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
			const int = (v: unknown): number => (/^-?\d+$/.test(str(v)) ? Number(str(v)) : Number.NaN)
			const refuse = (error: string) =>
				c.json({ Value: null, Success: false, Error: error, error_id: null })

			const offerId = str(body.PurchaseOfferId)
			const found = offerId === '' ? null : await findPurchaseOffer(c.env.DB, offerId)
			if (found === null) return refuse('No such purchase offer')
			const { Offer: offer, RoomId: roomId } = found

			// An offer that hands over nothing, or costs less than nothing, is not for sale.
			if (!Number.isInteger(offer.CurrencyAmount) || offer.CurrencyAmount <= 0) {
				return refuse('Purchase offer is not available')
			}
			if (!Number.isInteger(offer.Price) || offer.Price < 0) {
				return refuse('Purchase offer is not available')
			}
			if (int(body.RequestedAmount) !== offer.CurrencyAmount) {
				return refuse('Requested amount does not match')
			}

			const ownerId = await getRoomOwnerId(c.env.DB, roomId)
			if (ownerId === null) return refuse('Purchase offer is not available')

			// The room's owner and co-owners take from their own shop for free: the client
			// shows THEM the offer at no cost and posts `RequestedPrice=0`, so holding a
			// contributor to the offer's price refused every purchase they made. Nobody is
			// charged — the owner paying themselves would be a debit and a credit of the same
			// tokens, and a co-owner is building the shop, not buying from it — so the posted
			// price is not checked for them at all; everyone else must have seen the real one.
			const canManage = (await canManageRoomById(c.env.DB, roomId, id)) === true
			if (!canManage && int(body.RequestedPrice) !== offer.Price) {
				return refuse('Requested price does not match')
			}

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			const tokens = CurrencyType.RecCenterTokens
			const charged = offer.Price > 0 && !canManage
			// Charged FIRST, and atomically: a buyer who cannot pay is handed nothing.
			if (charged && !(await spendCurrency(c.env.DB, id, tokens, offer.Price, startingTokens))) {
				return refuse('Not enough tokens')
			}

			const { Balance: currencyBalance } = await awardRoomCurrency(
				c.env.DB,
				offer.CurrencyId,
				id,
				offer.CurrencyAmount
			)

			if (charged) {
				// Seed the owner's signup grant BEFORE crediting them — `creditCurrency` upserts
				// the row, which would otherwise cost a never-seen owner their starting tokens.
				await ensureStartingBalances(c.env.DB, ownerId, startingTokens)
				const ownerBalance = await creditCurrency(
					c.env.DB,
					ownerId,
					tokens,
					offer.Price,
					startingTokens
				)
				// Both frames carry a RESULTING total — see the frame rule above pushBalanceUpdate.
				await pushBalanceUpdate(c, ownerId, tokens, ownerBalance)
			}
			const tokenBalance = await getBalance(c.env.DB, id, tokens, startingTokens)
			if (charged) await pushBalancePurchase(c, id, tokens, -offer.Price, tokenBalance)

			// Both balances are RESULTING totals. `Platform` names the one account-wide bucket,
			// like every other token balance this worker reports.
			return c.json({
				Value: {
					CurrencyBalanceResponse: {
						AccountId: id,
						CurrencyId: offer.CurrencyId,
						Balance: currencyBalance,
						ModifiedAt: new Date().toISOString(),
					},
					TokenBalanceResponse: {
						Balance: tokenBalance,
						CurrencyType: tokens,
						Platform: ALL_PLATFORMS,
					},
				},
				Success: true,
				Error: null,
				error_id: null,
			})
		}
	)

	// The room-economy surface the client asks for on entering a room: the room's own
	// inventory/offers/gift-drop shops and the caller's slice of them. Nothing here is
	// stored yet, so every one is an empty list — the client reads that as "this room
	// sells nothing" and renders no shop, where a 404 stalls the room load instead.
	//
	// The `/player` and `purchaseCounts` variants are caller-scoped but deliberately
	// unauthed, matching the `roomConsumable/.../me` stub above: an empty list is the
	// same answer for every caller, so there's nothing to protect until something
	// writes here. Gate them when they start returning real data.
	.get(
		'/econ/roomInventory/room/:roomId',
		listRoute('A room’s inventory', 'Empty stub so the client doesn’t 404'),
		(c) => c.json([])
	)
	.get(
		'/econ/roomInventory/room/:roomId/player',
		listRoute('The caller’s inventory in a room', 'Empty stub'),
		(c) => c.json([])
	)
	.get(
		'/econ/roomInventoryItemTags/room/:roomId',
		listRoute('A room’s inventory item tags', 'Empty stub'),
		(c) => c.json([])
	)
	.get('/econ/roomOffer/room/:roomId', listRoute('A room’s offers', 'Empty stub'), (c) =>
		c.json([])
	)
	.get(
		'/econ/roomOffer/room/:roomId/purchaseCounts',
		describeRoute({
			summary: 'Per-offer purchase counts for a room',
			responses: {
				200: json(
					z.union([
						JsonArray,
						z.object({
							Value: JsonArray,
							Success: z.boolean(),
							Error: z.string().nullable(),
							error_id: z.string().nullable(),
						}),
					]),
					'2026: RecNet result envelope; older builds: a list'
				),
			},
		}),
		async (c) => {
			if (((await authedBuild(c)) ?? 0) >= 20260323) {
				// The 2026 client decodes RecNetResultListObject<RoomOfferPurchaseCountDTO>.
				return c.json({ Value: [], Success: true, Error: null, error_id: null })
			}
			return c.json([])
		}
	)
	// A room's recent offer purchases. Nothing records them yet, so always an empty list,
	// in the RecNet result envelope the client asks for (every build).
	.get(
		'/econ/roomOffer/room/:roomId/recentPurchases',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s recent offer purchases',
			description:
				'Empty stub: no room offer purchases are recorded yet. Answers the ' +
				'`{ Value, Success, Error, error_id }` envelope with an empty `Value`.',
			responses: {
				200: json(
					z.object({
						Value: JsonArray,
						Success: z.boolean(),
						Error: z.string().nullable(),
						error_id: z.string().nullable(),
					}),
					'An empty list in the RecNet result envelope'
				),
			},
		}),
		(c) => c.json({ Value: [], Success: true, Error: null, error_id: null })
	)
	.get(
		'/econ/roomGiftDropShops/room/:roomId',
		listRoute('A room’s gift-drop shops', 'Empty stub'),
		(c) => c.json([])
	)

	// A room's economy config, asked for alongside the room-economy lists above. The only
	// setting is whether the room's shop UI groups its offers into sorting tabs; nothing
	// stores per-room config yet, so every room answers false and the client renders one
	// flat list. [Authorize] — unlike the empty-list stubs above this is a real answer the
	// client acts on, so it takes the same token the rest of the econ surface does.
	.get(
		'/econ/roomEconConfig/:roomId',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s economy config',
			description: [
				'Whether the room’s shop groups offers into sorting tabs. No per-room config is',
				'stored, so this is always false; the `RoomId` is echoed from the path.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomEconConfig, 'The room’s economy config'),
				400: { description: 'Non-numeric roomId (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const roomId = Number.parseInt(c.req.param('roomId'), 10)
			if (Number.isNaN(roomId)) return c.body(null, 400)
			return c.json({ RoomId: roomId, EnableSortingTabs: false })
		}
	)

	// The paintball battle pass's season config. A stub: nothing stores a season yet, so
	// every caller is served the one example season below, verbatim.
	.get(
		'/paintball-battle-pass/config',
		describeRoute({
			tags: ['Econ'],
			summary: 'The paintball battle pass config (stub)',
			description: 'A fixed example season — no battle pass is stored yet.',
			responses: { 200: json(JsonObject, 'The battle pass config') },
		}),
		(c) =>
			c.json({
				BattlePassId: 1,
				Name: 'Season 1',
				ValidRoomIds: [112],
				StartTime: '2026-10-01T00:00:00Z',
				EndTime: '2026-12-01T00:00:00Z',
				Levels: [{ XpRequired: 100, RewardGiftDropIds: [1] }],
				EventXP: { '1': 10, '2': 25, '3': 50, '4': 100 },
				BoostConfig: {
					TemporaryBoostDurationInMinutes: 60,
					TemporaryBoostXpMultiplierPercentage: 50,
					PermanentBoostXpMultiplierPercentage: 25,
					SocialBoostXpMultiplierPercentage: 10,
					MaxBoostXpMultiplierPercentage: 100,
				},
				DailyParticipationBonusLimit: 5,
				MinimumParticipationTimeInSeconds: 120,
				PurchasableSkus: [{ Type: 1, TokenPrice: 1000, BonusLevels: 0, PermanentBoost: false }],
				PermanentBoostTokenPrice: 500,
				LimitedTimeReward: { CompletionDeadline: '2026-11-01T00:00:00Z', GiftDropIds: [9] },
			})
	)

	// The timed currency grant the client polls. A stub: nothing accrues or is granted yet,
	// so every caller is served the one example grant below, verbatim. Takes no body.
	.post(
		'/api/timedCurrencyGrants/update',
		describeRoute({
			tags: ['Econ'],
			summary: 'The timed currency grant (stub)',
			description: 'A fixed example grant — no timed grant is stored or paid out yet.',
			responses: { 200: json(JsonObject, 'The timed currency grant') },
		}),
		(c) =>
			c.json({
				TimedCurrencyGrantId: 1,
				Name: 'Daily Tokens',
				StartTime: '2026-10-01T00:00:00Z',
				EndTime: '2026-12-01T00:00:00Z',
				CurrencyType: 0,
				OfflineRatePerHour: 1.0,
				OnlineRatePerHour: 5.0,
				ActiveExperiment: null,
			})
	)

	// The client reporting how far the player has moved, towards a distance-moved reward
	// track. A stub: the form body (`distanceMeters=12.5`) is not read, nothing is tracked,
	// and the answer is an empty 200.
	.post(
		'/api/distanceMovedRewardTracks/distance',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report distance moved (stub)',
			description:
				'Takes a form-encoded `distanceMeters` and stores nothing — no reward track exists yet.',
			responses: { 200: { description: 'Empty body' } },
		}),
		(c) => c.body(null, 200)
	)

	// Everything a room sells, in one list: its keys, its consumables and the purchase offers
	// of its currencies, each as the client's 10-key `UgcPurchasableItem` with `ItemType`
	// saying which (0 key, 1 consumable, 3 currency pack). Asked for on every room load. A
	// room that sells nothing is `[]` — the client's decoder throws on `{}` or an empty body.
	.get(
		'/api/ugcPurchasables/v1/items/room/:roomId{[0-9]+}',
		describeRoute({
			tags: ['Rooms'],
			summary: 'A room’s purchasables',
			description:
				'The room’s shop as one flat list: its room keys (`ItemType` 0), room consumables ' +
				'(1) and the purchase offers of each of its currencies (3), assembled from the ' +
				'`room_key`, `room_consumable` and `room_currency` tables. `ItemId` is a bare GUID ' +
				'— a key’s `ReplicationId`, a consumable’s `RoomConsumableId`, an offer’s ' +
				'`CurrencyPurchaseOfferId` — with the kind beside it as `ItemType`, not the ' +
				'`{ itemType, itemId }` struct the bulk lookup takes. `PurchaseCurrencyId` is the ' +
				'room currency a line is charged in, or null for tokens (every currency pack). A room ' +
				'that sells nothing is an empty array.',
			parameters: [
				{
					name: 'roomId',
					in: 'path',
					required: true,
					description: 'The room whose shop to list',
					schema: { type: 'string', pattern: '^[0-9]+$' },
				},
			],
			responses: { 200: json(RoomPurchasableList, 'The room’s shop') },
		}),
		async (c) =>
			c.json(await getRoomPurchasables(c.env.DB, Number.parseInt(c.req.param('roomId'), 10)))
	)

	// Bulk lookup of UGC purchasables by `{ itemType, itemId }`. Only custom avatar items
	// (type 3) exist to resolve; they come off the api-owned `custom_avatar_item` table.
	.post(
		'/api/ugcPurchasables/v1/items/bulk',
		describeRoute({
			tags: ['Rooms'],
			summary: 'Look up UGC purchasables by id',
			description:
				'Resolves `Ids[]` (`{ itemType, itemId }`) against the `custom_avatar_item` table and ' +
				'answers the store-facing `UgcPurchasableItem` view of each, in request order. ' +
				'Only `itemType` 3 (custom avatar item) is served; other types and unknown ids are ' +
				'dropped. `RoomId` is echoed onto every item — what the client wants it for is ' +
				'not yet known. `PurchaseCurrencyId` is null until a currency exists.',
			security: AUTHED,
			requestBody: jsonBody(UgcPurchasableBulkRequest, 'The room and the ids to resolve'),
			responses: {
				200: json(UgcPurchasableItemList, 'The resolved items (unknown ids omitted)'),
				400: json(ErrorResponse, 'Malformed body'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (!body || !Array.isArray(body.Ids)) return c.json({ error: 'Ids is required' }, 400)
			const roomId = typeof body.RoomId === 'number' ? body.RoomId : 0
			const ids = (body.Ids as unknown[]).flatMap((ref) => {
				if (!ref || typeof ref !== 'object') return []
				const { itemType, itemId } = ref as Record<string, unknown>
				return itemType === UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM && typeof itemId === 'string'
					? [itemId]
					: []
			})
			const items = await getCustomAvatarItems(c.env.DB, ids)
			return c.json(items.map((item) => toUgcPurchasable(item, roomId)))
		}
	)

	// How the items in a store row may be BOUGHT — the counterpart of the bulk lookup above.
	// The row itself carries only ids; the client asks this for the price tag, the sale
	// banner, the “new” pip and whether the gift button is drawn. It answers one entry per
	// RESOLVED id, in request order, dropping ids it doesn't know exactly as the bulk lookup
	// does — an item with no purchase info renders as not-for-sale rather than at price zero.
	//
	// Two shapes meet in one object here and neither may be tidied into the other: the
	// request's `{ itemType, itemId }` reference is camelCase, and the response nests THAT
	// object, members unchanged, under a PascalCase `ItemId` beside PascalCase siblings.
	.post(
		'/api/items/purchaseInfos',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Purchase info for a bag of items',
			description: [
				'Resolves `Ids[]` (`{ itemType, itemId }`) against the `custom_avatar_item` table and',
				'answers how each may be bought: its price in RecCenterTokens, its availability window',
				'and the flags the store row draws. Only `itemType` 3 (custom avatar item) is served;',
				'other types and unknown ids are dropped, so the response is one entry per RESOLVED',
				'id in request order — never a positional match for `Ids[]`.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(ItemPurchaseInfosRequest, 'The ids to price'),
			responses: {
				200: json(ItemPurchaseInfoList, 'The resolved items’ purchase info (unknown ids omitted)'),
				400: json(ErrorResponse, 'Malformed body'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (!body || !Array.isArray(body.Ids)) return c.json({ error: 'Ids is required' }, 400)
			const ids = (body.Ids as unknown[]).flatMap((ref) => {
				if (!ref || typeof ref !== 'object') return []
				const { itemType, itemId } = ref as Record<string, unknown>
				return itemType === UGC_ITEM_TYPE_CUSTOM_AVATAR_ITEM && typeof itemId === 'string'
					? [itemId]
					: []
			})
			const items = await getCustomAvatarItems(c.env.DB, ids)
			return c.json(items.map(toItemPurchaseInfo))
		}
	)

	// Store listings by `PurchasableItemId` — `{ PurchasableItemIds: [2594], GiftDropIds: null }`.
	// Answers a bare array of the listings exactly as the served 2025 store (`sf3-2025.json`)
	// lists them, read from the `catalog` table's `listing` column rather than the 4 MB file
	// (a row's `catalog_id` IS its `PurchasableItemId`). Every item kind resolves; unknown ids
	// are dropped, so the answer is in request order but not positional. `GiftDropIds` has only
	// been seen null and is ignored. No auth: a listing is what the public store shows anyone.
	.post(
		'/api/storefronts/v1/purchasableitems',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Store listings by PurchasableItemId',
			description: [
				'Resolves `PurchasableItemIds[]` against the `catalog` table and answers each listing',
				'verbatim as the served 2025 store (`sf3-2025.json`) lists it — `GiftDrop`, `Prices`,',
				'`SubscriberPrices` and the rest. Avatar items, consumables, skins and custom avatar',
				'items all resolve. Unknown ids (and repeats) are dropped, so the response follows',
				'request order but is never a positional match. `GiftDropIds` is ignored.',
			].join(' '),
			requestBody: jsonBody(PurchasableItemsRequest, 'The listings to resolve'),
			responses: {
				200: json(JsonArray, 'The resolved listings (unknown ids omitted)'),
				400: json(ErrorResponse, 'Malformed body'),
			},
		}),
		async (c) => {
			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (!body || typeof body !== 'object')
				return c.json({ error: 'A JSON body is required' }, 400)
			const raw = body.PurchasableItemIds
			if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
				return c.json({ error: 'PurchasableItemIds must be an array' }, 400)
			}
			const ids = ((raw as unknown[] | null | undefined) ?? []).filter((id): id is number =>
				Number.isInteger(id)
			)
			const listings = await getStoreListings(c.env.DB, ids)
			const build = await authedBuild(c)
			// Les prix de base, les mêmes que le catalogue servi : le tableau du Rec Center
			// affiche ces fiches, donc c'est ici que passe son prix.
			if (build === null || build <= Number(GAME_VERSION) || ids.length === 0)
				return c.json(basePriceListings(listings))

			// The catalog table is populated from the 2025 store by `runx catalog load`,
			// which is not part of a worker deploy. A 2025 client must still get the exact
			// listings its bundled store page shows, so fall back to the served dump for ids
			// the table does not know yet (2023 never enters this branch).
			const store = await store2025Listings(c.env.ASSETS, c.req.url)
			const byId = new Map(listings.map((listing) => [listing.PurchasableItemId, listing]))
			return c.json(
				basePriceListings(
					Array.from(new Set(ids)).flatMap((id) => {
						const listing = byId.get(id) ?? store.get(id)
						return listing === undefined ? [] : [listing]
					})
				)
			)
		}
	)

	// The consumable DEFINITIONS the client knows how to use (`?supportedVersion=2`), as
	// opposed to the ones a player owns. Served verbatim from `static/consumables.json`, the
	// live game's list; `supportedVersion` is accepted and unused. A row's `ConfigurationData`
	// is JSON escaped into a STRING (`"{\"MeshConfigurationData\":null,…}"`), or null.
	.get(
		'/api/consumables/v1/all',
		describeRoute({
			tags: ['Consumables'],
			summary: 'All consumable definitions',
			description:
				'Every consumable definition, verbatim from static/consumables.json. supportedVersion is ignored.',
			responses: { 200: json(JsonArray, 'The consumable definitions') },
		}),
		(c) => c.json(consumableDefinitions)
	)

	// STUB. The client's lookup of consumable definitions by descriptor
	// (`?configurationVersion=2`), form-encoded with one repeated key:
	// `descriptors=xfeDIDboPES-AS90CCn2xQ&descriptors=test_bad`. The answer is an array of
	// definitions — `{ ConsumableItemDesc, InitialCount, CreatedAt, ThumbnailImageName,
	// FriendlyName, RoomieCategory, ConsumableToolName, ConfigurationData }`, with
	// `ConfigurationData` JSON escaped into a string as on `/all` — holding only the
	// descriptors that resolve. Nothing here can resolve one yet, so every query answers [].
	.post(
		'/api/consumables/v1/query/bulk',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Look up consumable definitions by descriptor (stub)',
			description: [
				'STUB. Takes a form body repeating `descriptors` once per consumable descriptor and',
				'answers the definitions that resolve. There is no lookup behind it yet, so the',
				'answer is always []. configurationVersion is ignored.',
			].join(' '),
			requestBody: form(QueryConsumablesRequest, 'The descriptors to look up'),
			responses: { 200: json(JsonArray, 'The matching definitions (always empty for now)') },
		}),
		async (c) => {
			const body = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>)
			const descriptors = body['descriptors']
			logger.info('consumable query/bulk (stub, nothing resolved)', { descriptors })
			return c.json([])
		}
	)

	// Unlocked consumables. [Authorize]. The consumables the player has bought (from
	// `buyItem`, stored in the `consumable` table), grouped by item into the client's
	// unlocked-consumable DTO. A player who has bought none gets an empty list.
	.get(
		'/api/consumables/v2/getUnlocked',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Unlocked consumables',
			description: [
				'The consumables the player has bought (from buyItem, in the consumable table),',
				'grouped by item into the unlocked-consumable DTO (Ids/CreatedAts per instance,',
				'Count their sum). [] when they’ve bought none.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(JsonArray, 'Grouped unlocked consumables (empty when none)'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const consumables = await getConsumables(c.env.DB, id)
			// The 2026 client includes this flag in the instance key and verifies it against the
			// definition, so it comes from the definition — see `isRroConsumable`.
			return c.json(
				((await authedBuild(c)) ?? 0) >= 20260323
					? consumables.map((item) => ({
							...item,
							IsRRO: isRroConsumable(item.ConsumableItemDesc),
						}))
					: consumables
			)
		}
	)

	// Consume a quantity of an owned consumable instance. [Authorize]. Body is JSON
	// `{ Id, DeltaCount }` where `Id` is the consumable row id. Reduces that instance's
	// count by DeltaCount, deleting the row once it hits zero. Scoped to the caller so
	// they can only consume their own. Envelope mirrors the gift-consume ack.
	.post(
		'/api/consumables/v1/consume',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Consume a quantity of an owned consumable',
			description: [
				'Reduces the given consumable instance’s count by `DeltaCount` (default 1), deleting',
				'the row at zero. Scoped to the caller. Pushes a ConsumableMappingRemoved socket',
				'notification. Envelope mirrors the gift-consume ack.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(ConsumeConsumableRequest, 'The consumable id and delta'),
			responses: {
				200: json(ConsumeEnvelope, 'Success envelope'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.json<{ Id?: unknown; DeltaCount?: unknown }>()
				.catch(() => ({}) as { Id?: unknown; DeltaCount?: unknown })
			const consumableId = typeof body.Id === 'number' ? body.Id : Number.NaN
			const delta = typeof body.DeltaCount === 'number' ? body.DeltaCount : 1
			if (!Number.isNaN(consumableId) && delta > 0) {
				const consumed = await consumeConsumable(c.env.DB, id, consumableId, delta)
				// Notify the player so their client removes/updates the item in inventory.
				if (consumed !== null) await pushConsumableRemoved(c, id, consumed)
			}
			return c.json({ error: '', success: true, value: null })
		}
	)

	// STUB. The client posts `{ Id, IsActive, ActivatedByRoomie }` when a consumable starts
	// or stops being used — `Id` is the consumable row id, as on `/consume`. Nothing is
	// stored: the body is read only to log it, and the client ignores the response entirely,
	// so none is sent.
	//
	// What this most likely means: the consumable is IN USE, and marking it so is what keeps
	// a player from reusing one before it is over (a second Confetti Cannon while the first
	// is still firing), and `ActivatedByRoomie` says a roommate set it off rather than its
	// owner. That is a guess from the field names, not observed behaviour, so no row flips
	// and `/consume` is unchanged. When the client's reading of it is known, this is where
	// an `is_active` flag on the consumable row (and a refusal on `/consume`) would go.
	.post(
		'/api/consumables/v1/updateActive',
		describeRoute({
			tags: ['Consumables'],
			summary: 'Mark a consumable active or inactive (stub)',
			description: [
				'STUB. Accepts `{ Id, IsActive, ActivatedByRoomie }` — the client posting that one',
				'of its consumables has started or stopped being used — and stores nothing. The',
				'client ignores the response entirely, so this answers an empty 200.',
				'',
				'Believed to mark the consumable as IN USE so it cannot be reused before it is over,',
				'with `ActivatedByRoomie` saying a roommate set it off; that is a guess from the field',
				'names, and nothing acts on it yet. `/consume` is unaffected.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(UpdateActiveConsumableRequest, 'The consumable and its new state'),
			responses: {
				200: { description: 'Empty body — the client ignores the response entirely' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.json<Record<string, unknown>>()
				.catch(() => ({}) as Record<string, unknown>)
			logger.info('consumable updateActive (stub, not stored)', {
				accountId: id,
				consumableId: body.Id,
				isActive: body.IsActive,
				activatedByRoomie: body.ActivatedByRoomie,
			})
			return c.body(null, 200)
		}
	)

	// Currency balance. [Authorize]. The trailing int is a CurrencyType — the client
	// fetches `/balance/2` (RecCenterTokens) on load. Backed by the `balance` table; a
	// player who has never been granted gets their starting balance on this first read.
	//
	// An unknown or non-account-scoped currency (a room currency, ProgressionEvent,
	// Invalid) returns a 0 balance rather than 404: the client treats a failed balance
	// fetch as a load error, and "you have none of that" is the honest answer anyway.
	.get(
		'/api/storefronts/v4/balance/:currencyType',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Currency balance',
			description: [
				'The player’s balance in a CurrencyType (the client fetches `/balance/2`,',
				'RecCenterTokens, on load). A first read seeds their starting balance. An unknown or',
				'non-account currency returns a 0 balance rather than 404.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'currencyType',
					in: 'path',
					required: true,
					description: 'CurrencyType integer; non-numeric is 400',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(BalanceEntry.array(), 'A single-entry balance array'),
				400: { description: 'Non-numeric currencyType (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const currencyType = Number.parseInt(c.req.param('currencyType'), 10)
			if (Number.isNaN(currencyType)) return c.body(null, 400)
			const amount = isSpendable(currencyType)
				? await getBalance(
						c.env.DB,
						id,
						currencyType,
						intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
					)
				: 0
			return c.json([{ CurrencyType: currencyType, Platform: ALL_PLATFORMS, Balance: amount }])
		}
	)

	// Gift-drop storefront. Serves `static/storefronts/sf{id}.json` for the requested
	// storefront id via the ASSETS binding; 404s when no such catalog exists. A few ids are
	// stand-ins for another storefront's catalog (see `STOREFRONT_ALIASES`) — resolved through
	// the same helper `buyItem` uses, so an aliased storefront can be bought from as well as
	// browsed.
	.get(
		'/api/storefronts/v3/giftdropstore/:id',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Gift-drop storefront catalog',
			description: [
				'Serves the `sf{id}.json` catalog via the ASSETS binding. 404 when none exists. An id',
				'with no capture of its own may stand in for another storefront’s catalog (see',
				'`STOREFRONT_ALIASES`, currently empty), and such an alias applies to purchases from',
				'that storefront too, not just to this listing. Which FILE a storefront reads from can',
				'also depend on the caller’s build (`rn.ver`): storefront `3` serves the 2023',
				'`sf3.json` to builds up to 20230414 and the 2025 store dump `sf3-2025.json` to later',
				'ones. The id does not change, and the same resolution applies to purchases, so what',
				'is browsed is what is charged.',
			].join(' '),
			parameters: [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: 'Storefront id (selects sf{id}.json)',
					schema: { type: 'string' },
				},
			],
			responses: {
				200: json(JsonObject, 'The storefront catalog'),
				404: { description: 'No such storefront catalog' },
			},
		}),
		async (c) => {
			const id = c.req.param('id')
			// The same resolution `loadStorefront` uses, so what is browsed is what a purchase is
			// checked against — see `storefrontAssetPath`.
			const build = await authedBuild(c)
			const path = storefrontAssetPath(id, build)
			const res = await c.env.ASSETS.fetch(new URL(path, c.req.url))
			if (!res.ok) return c.notFound()
			// The REC BLUE Plus subscription and the bundles are not in any `sf*.json` — they
			// are added here too, or the client would list a store they cannot see them in.
			// Les mêmes prix de base, la même rotation du jour et les mêmes extras que
			// `loadStorefront` : ce qui est affiché est ce qui est facturé.
			const catalog = dailyStorefront(basePriceStorefront((await res.json()) as Storefront))
			// Même thématisation que `loadStorefront` : pendant la boutique Halloween, ce qui est
			// affiché ici est ce qui sera facturé là-bas.
			const themed = await themedCatalog(c, catalog, Number(id), build)
			const extras = await withRecBlueExtras(c, themed, Number(id))
			return c.json(withRecBluePlus(extras, Number(id)))
		}
	)

	// Buy a storefront item. [Authorize]. The client posts the storefront/item ids, the
	// currency and the price it sees; we look the item up in that storefront's catalog,
	// confirm the price the client sent still matches, debit the buyer atomically, grant
	// the item into the recipient's inventory, and hand back a gift box.
	//
	// The buyer is always the caller; a `Gift` block routes the item (and box) to another
	// player, but the caller pays. Ownership is persisted at purchase — the gift box is
	// only the cosmetic "open it" moment, so the grant does not wait for the box to be
	// opened (see /api/avatar/v2/gifts/consume on the `api` worker, which just deletes it).
	//
	// `RequestedPrice` is the price the client rendered; rejecting a mismatch stops a stale
	// client (or a tampered request) from buying at a price the catalog no longer offers.
	.post(
		'/api/storefronts/v2/buyItem',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a storefront item',
			description: [
				'Looks the item up in its storefront catalog, confirms the client’s `RequestedPrice`',
				'still matches the `Prices` entry — a Rec Room Plus subscriber (the same `rn.plus`',
				'check as `UpdateAndGetSubscription`) may pay anywhere from that down to 10% off, since their',
				'client applies the discount itself and not to every item — debits the buyer atomically,',
				'grants the item (into the inventory or',
				'consumable table), and returns a gift box. A `Gift` block routes the item — and its',
				'box — to the player it names, who is handed it over the hub as',
				'`GiftPackageReceivedImmediate`; the caller always pays, and `Anonymous` hides them',
				'from the box rather than withholding it. `Balance` in the response is the CHANGE (negated',
				'price), not the new total. Pushes a StorefrontBalancePurchase socket frame that SETS the',
				'buyer’s account-wide bucket to the RESULTING total, so the frame, this body and a',
				'`GET /balance` re-fetch all agree (`Delta` there is display-only).\n\n' +
				'An item whose `GiftDrop.SubscribersOnly` is true is sold to a Rec Room Plus member only: a',
				'buyer without Plus is refused with a 403 and nothing is charged, so the Plus-only outfits',
				'stay Plus-only however the client renders them.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(BuyItemRequest, 'The item, currency, price, and optional Gift'),
			responses: {
				200: json(BuyItemResponse, 'The purchase result (gift box + balance change)'),
				400: json(ErrorResponse, 'Invalid body, unavailable currency, or insufficient balance'),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'The item is for Rec Room Plus members, and the buyer has none'),
				404: json(ErrorResponse, 'No such item, or a `Gift` naming a player that does not exist'),
				409: json(ErrorResponse, 'The price has changed since the client rendered it'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				return c.json({ error: 'Invalid request body' }, 400)
			}
			const storefrontType = body.StorefrontType
			const purchasableItemId = body.PurchasableItemId
			const currencyType = body.CurrencyType
			const requestedPrice = body.RequestedPrice
			if (
				!Number.isInteger(storefrontType) ||
				!Number.isInteger(purchasableItemId) ||
				!Number.isInteger(currencyType) ||
				!Number.isInteger(requestedPrice)
			) {
				return c.json(
					{
						error:
							'StorefrontType, PurchasableItemId, CurrencyType and RequestedPrice are required',
					},
					400
				)
			}

			// A refused purchase reaches the player as a bare "An error occurred", and nothing in
			// the client's log carries the ids it sent. Log the request before anything can refuse
			// it: the storefront and item ids are what tell a catalog mismatch apart from a stale
			// client, and `requestedPrice` is what the 409 below turns on.
			const build = await authedBuild(c)
			logger.info('buyItem', {
				accountId: id,
				build,
				storefrontType,
				purchasableItemId,
				currencyType,
				requestedPrice,
			})

			const item = await findStoreItem(c, storefrontType as number, purchasableItemId as number)
			if (item === null) {
				logger.warn('buyItem refused: no such item in that storefront catalog', {
					accountId: id,
					build,
					storefrontType,
					purchasableItemId,
				})
				return c.json({ error: 'Item not found' }, 404)
			}

			const subscriber = await isSubscriber(c)
			// Une tenue Rec Room Plus (le drapeau `SubscribersOnly` du catalogue) ne se vend qu'à un
			// abonné. Le client masque le bouton aux non-membres, mais il ne l'empêche pas : ce
			// refus est le seul verrou, et il tombe avant tout débit.
			if (item.GiftDrop.SubscribersOnly === true && !subscriber) {
				logger.warn('buyItem refused: the item is for Rec Room Plus members', {
					accountId: id,
					build,
					storefrontType,
					purchasableItemId,
				})
				return c.json({ error: 'Rec Room Plus required' }, 403)
			}

			// A subscriber's client prices the item itself and posts the result, so the check is a
			// band rather than one number — see `priceCheck`. `charge` is what they asked to pay.
			const checked = priceCheck(item, currencyType as number, subscriber, requestedPrice)
			if (checked === 'no-currency') {
				logger.warn('buyItem refused: the item is not sold in that currency', {
					accountId: id,
					storefrontType,
					purchasableItemId,
					currencyType,
				})
				return c.json({ error: 'Currency type not available for this item' }, 400)
			}
			if (checked === 'mismatch') {
				logger.warn('buyItem refused: the price the client rendered is not the one on sale', {
					accountId: id,
					storefrontType,
					purchasableItemId,
					currencyType,
					requestedPrice,
				})
				return c.json({ error: 'Price has changed' }, 409)
			}
			const price = checked.charge
			// The item's currency must be an account balance we can debit (RecCenterTokens et al),
			// not a room-scoped or non-spendable currency.
			if (!isSpendable(currencyType as number)) {
				return c.json({ error: 'Currency type is not spendable' }, 400)
			}

			const gift = (
				typeof body.Gift === 'object' && body.Gift !== null ? body.Gift : null
			) as GiftRequest | null
			const receiverId = Number.isInteger(gift?.ToPlayerId) ? (gift?.ToPlayerId as number) : id
			// A named (non-anonymous) gift shows the sender; a self-purchase or an anonymous gift
			// is attributed to the "Coach" system account (id 1), never a null/0 sender.
			const fromPlayerId = gift !== null && gift.Anonymous !== true ? id : COACH_ACCOUNT_ID
			const message = giftMessage(gift)
			const giftContext = Number.isInteger(gift?.GiftContext) ? (gift?.GiftContext as number) : null
			// A gift is paid for here and granted THERE, so an id that names nobody would take the
			// buyer's tokens and strand the box on an account that will never read it. The client
			// only offers players it just looked up, so this is a tampered or stale id — refuse it
			// before charging rather than after.
			if (receiverId !== id && (await getAccount(c.env.DB, receiverId)) === null) {
				return c.json({ error: 'No such player to gift to' }, 404)
			}

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			// Debit the buyer atomically; a false return means they couldn't afford it and
			// nothing changed, so no item is granted.
			const paid = await spendCurrency(c.env.DB, id, currencyType as number, price, startingTokens)
			if (!paid) {
				logger.warn('buyItem refused: the buyer cannot afford it', {
					accountId: id,
					storefrontType,
					purchasableItemId,
					currencyType,
					price,
				})
				return c.json({ error: 'Insufficient balance' }, 400)
			}

			// Grant the item to the recipient, with the gift box that renders it. A box (an
			// `IsQuery` drop, e.g. sf2's "4-Star Unique Box") rolls its prize in here, and
			// `granted.drop` is what the roll landed on — the response has to describe THAT, not
			// the box, or a query purchase answers with every item field empty and the client
			// draws an empty box.
			const granted = await grantGiftDrop(c, receiverId, item.GiftDrop, message, {
				fromPlayerId,
				giftContext,
			})

			// The buyer reads their own box out of the response below, but a gift's receiver has
			// no response to read — they may not even be online. Hand them the box the way every
			// other server-handed box arrives, so it pops in front of them instead of waiting for
			// their client's next `GET /api/avatar/v2/gifts`.
			if (receiverId !== id) {
				await pushGiftReceived(c, receiverId, granted, message, fromPlayerId, giftContext)
			}

			// L'item REC BLUE Plus n'est pas un objet : il pose l'abonnement sur le compte qui
			// le reçoit (l'acheteur, ou le joueur à qui il l'offre).
			if (purchasableItemId === REC_BLUE_PLUS_ITEM_ID) {
				await grantRecBluePlus(c, receiverId)
			}
			// Les bundles vendent leur contenu, pas eux-mêmes.
			const bundle = REC_BLUE_BUNDLES[Number(purchasableItemId)]
			if (bundle !== undefined) {
				await grantRecBlueBundle(c, receiverId, bundle)
			}

			// Push the spend to the buyer (`id` — the caller is who was charged) so their client
			// updates without waiting for a `GET /balance` re-fetch. StorefrontBalancePurchase
			// SETS the account-wide bucket to the resulting total read back from D1, so it agrees
			// with both the response body below and any re-fetch instead of compounding with them
			// — see the frame rule above pushBalanceUpdate. Best-effort.
			const newBalance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
			await pushBalancePurchase(c, id, currencyType as number, -price, newBalance)

			// The response mirrors a captured real buyItem: `Balance` is the change applied (the
			// negated price), not the resulting balance (the client reads its new total from
			// `GET /balance/:type`); `BalanceType` is -2 (account-wide, all platforms).
			return c.json({
				BalanceUpdates: [
					{
						UpdateResponse: 0,
						Data: [toBalanceUpdateData(granted, fromPlayerId, message, giftContext)],
					},
				],
				Balance: -price,
				CurrencyType: currencyType,
				BalanceType: ALL_PLATFORMS,
			})
		}
	)

	// Check out a whole shopping bag. [Authorize]. The client posts every line it has in the
	// bag — an item id, `DuplicateItemCount` copies, the unit price it rendered and an
	// optional Gift — plus the ONE storefront and the ONE currency they all share.
	//
	// The whole bag is debited in ONE `spendCurrency` call. Charging line by line would let a
	// bag half-succeed on a race with another spend, and would push a balance frame per line.
	//
	// The response is NOT buyItem's envelope. It is `{ Success, Error, error_id, Value }`
	// (`error_id` lowercase — the client renames that one member; the other three are
	// PascalCase), and `Value` is a BalanceUpdateResponse: the RESULTING `{ Balance,
	// CurrencyType, Platform }` — `Platform` there being a renamed `BalanceType`, i.e. the
	// bucket, not a store — plus ONE `BalanceUpdates` entry per REQUESTED item.
	//
	// Per-line reporting is that entry's `UpdateResponse`: a line that didn't sell comes back
	// non-OK with a null `GiftPackage`, and `AllowPartialSuccess` is what lets those sit
	// beside successful ones while `Success` stays true. Without it, one bad line refuses the
	// whole bag — `Success: false`, the reason in `Error`, a null `Value`, nothing charged.
	.post(
		'/api/items/bulkpurchase',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a bag of storefront items',
			description: [
				'Resolves every line against the bag’s storefront catalog (one read for the whole',
				'bag) — or, for a line whose `ItemPurchaseMethodId` is a `Guid` (Type 1), against the',
				'`custom_avatar_item` table, the guid being a `CustomAvatarItemId` — confirms each',
				'line’s `RequestedPrice` still matches, debits the total in ONE atomic spend, grants',
				'what sold, and answers the `{ Success, Error, error_id, Value }` envelope. A custom',
				'item is a sale between players: its price is paid to its creator (pushed to them as',
				'a balance update), ownership lands in `inventory_custom`, its gift box names it by',
				'`CustomAvatarItemId`, and the entry’s `CustomAvatarItem` carries the item itself. A',
				'custom line may be gifted, and fails with AlreadyOwned when its receiver owns it,',
				'PlayerNotEligible when its receiver created it, and',
				'NoItemAvailable for a draft, an unknown id or a currency other than RecCenterTokens.',
				'`Value.Balance` is the RESULTING total (not buyItem’s change) in the',
				'`Platform` bucket named beside it, and `BalanceUpdates` carries one entry per',
				'REQUESTED item, each with its own `UpdateResponse`. `AllowPartialSuccess` lets some',
				'of those be non-OK while `Success` stays true; without it a single bad line refuses',
				'the bag and nothing is charged.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(BulkPurchaseRequest, 'The bag: its lines, storefront and currency'),
			responses: {
				200: json(BulkPurchaseResponse, 'The bag’s result, or `Success: false` if nothing sold'),
				400: json(BulkPurchaseResponse, 'A request that could not be evaluated at all'),
				401: UNAUTHORIZED_RESPONSE,
				404: json(BulkPurchaseResponse, 'A line gifts to a player that does not exist'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			// Every refusal answers the same envelope, so a client that only knows how to parse
			// this shape never has to special-case one. A null `Value` is legal here (the client's
			// validator only cascades into a non-null one), and it is the honest answer: nothing
			// was bought, so there is no balance to report and nothing to render.
			const refuse = (error: string, status: 200 | 400 | 404 = 200) =>
				c.json({ Success: false, Error: error, error_id: null, Value: null }, status)

			const body = (await c.req.json().catch(() => null)) as {
				PurchaseItemRequests?: PurchaseItemRequest[]
				StorefrontType?: number
				CurrencyType?: number
				BypassGiftPackages?: boolean
				AllowPartialSuccess?: boolean
				ShoppingBagId?: string | number | null
			} | null
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				return refuse('Invalid request body', 400)
			}
			const lines = body.PurchaseItemRequests
			if (!Array.isArray(lines) || lines.length === 0) {
				return refuse('PurchaseItemRequests must be a non-empty array', 400)
			}
			const storefrontType = body.StorefrontType
			const currencyType = body.CurrencyType
			if (!Number.isInteger(storefrontType) || !Number.isInteger(currencyType)) {
				return refuse('StorefrontType and CurrencyType are required', 400)
			}
			// The bag's currency must be an account balance we can debit, exactly as buyItem's.
			if (!isSpendable(currencyType as number)) {
				return refuse('Currency type is not spendable', 400)
			}
			const allowPartial = body.AllowPartialSuccess === true
			const skipGiftBox = body.BypassGiftPackages === true

			// One catalog read for the bag; every line resolves against it in memory. The file is
			// the whole catalog: the ids the discovery rows hand out (`lists`) are the store's own
			// `PurchasableItemId`s, so a numbered line resolves here or nowhere.
			const bagCatalog = await loadStorefront(c, storefrontType as number)
			// The bag may also name CUSTOM avatar items — a line whose id is a `Guid`, the item's
			// `CustomAvatarItemId` — which resolve against the `custom_avatar_item` table rather than
			// the catalog. One read for the items the bag names and one for which of them the buyer
			// already owns, so each line still resolves in memory.
			// Ownership is checked against each line's RECEIVER, so read it once per distinct
			// receiver of a guid line — the buyer, plus anyone a custom line gifts to.
			const guidLines = lines.flatMap((line) => {
				const method = toPurchaseMethodId(line.ItemPurchaseMethodId)
				return method.Type === PURCHASE_METHOD_TYPE_GUID && method.Guid !== null
					? [{ guid: method.Guid.toLowerCase(), receiverId: lineReceiver(line.Gift, id) }]
					: []
			})
			const guids = guidLines.map((line) => line.guid)
			const owned = new Map<number, Set<string>>()
			for (const receiverId of new Set(guidLines.map((line) => line.receiverId))) {
				owned.set(receiverId, await ownedCustomAvatarItemIds(c.env.DB, receiverId, guids))
			}
			const custom: CustomBagContext = {
				buyerId: id,
				items: new Map(
					(await getCustomAvatarItems(c.env.DB, guids)).map((item) => [
						item.CustomAvatarItemId.toLowerCase(),
						item,
					])
				),
				owned,
			}
			const subscriber = await isSubscriber(c)
			const resolved = lines.map((line) =>
				resolveBulkLine(line, bagCatalog, currencyType as number, subscriber, custom)
			)
			const buyable = resolved.filter(isBulkLine)

			const copies = buyable.reduce((n, line) => n + line.count, 0)
			if (copies > BULK_PURCHASE_CAP) {
				return refuse(`A bulk purchase is capped at ${BULK_PURCHASE_CAP} items`, 400)
			}
			// All-or-nothing: one unbuyable line stops the bag before anything is charged, and the
			// client is told why by the first thing that was wrong with it.
			const firstFailure = resolved.find((line): line is BulkLineFailure => !isBulkLine(line))
			if (!allowPartial && firstFailure !== undefined) return refuse(firstFailure.error)

			// Same as buyItem: a line gifting to an id that names nobody would charge the buyer and
			// strand the box. One lookup per DISTINCT recipient, and the whole bag refuses — a bad
			// recipient is a malformed request, not a line that merely didn't fit.
			const recipients = new Set<number>()
			for (const line of buyable) {
				const to = line.gift?.ToPlayerId
				if (Number.isInteger(to) && to !== id) recipients.add(to as number)
			}
			for (const to of recipients) {
				if ((await getAccount(c.env.DB, to)) === null) {
					return refuse('No such player to gift to', 404)
				}
			}

			// Decide what the balance covers BEFORE spending: lines are taken in request order
			// while they fit, so a bag that overruns still buys the items the player put in first.
			// The read is only for choosing; the single spend below is what actually settles, and
			// its `amount >= ?` guard is what makes that safe against a concurrent spend.
			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			const balance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
			const affordable: BulkPurchaseLine[] = []
			let total = 0
			for (const line of buyable) {
				const cost = line.price * line.count
				if (total + cost > balance) continue
				total += cost
				affordable.push(line)
			}
			const bought = new Set(affordable)
			// Without partial success an unaffordable line fails the whole bag — including the
			// lines that would have fitted, since the player asked for all of it or none.
			if (!allowPartial && affordable.length !== buyable.length) {
				return refuse('Insufficient balance')
			}
			// Nothing sold at all: there is no purchase to report, so this is a refusal rather
			// than a `Success: true` bag full of non-OK entries.
			if (affordable.length === 0) {
				return refuse(firstFailure?.error ?? 'Insufficient balance')
			}

			// One atomic debit for the whole bag. A false return means another request spent the
			// tokens between the read above and here, so nothing is granted and nothing changed.
			if (
				total > 0 &&
				!(await spendCurrency(c.env.DB, id, currencyType as number, total, startingTokens))
			) {
				return refuse('Insufficient balance')
			}

			// A query drop (a loot box) rolls against sf3, the big catalog. Read it ONCE for the
			// whole bag and only when a line actually holds one — a bag of ordinary items should
			// not pull a thousand-item catalog in to grant them.
			const rollCatalog = affordable.some(
				(line) => line.kind === 'catalog' && line.item.GiftDrop.IsQuery === true
			)
				? await loadRollCatalog(c)
				: undefined

			// Grant what sold, keeping each line's box so the entry built below can carry it.
			const packages = new Map<BulkPurchaseLine, Record<string, unknown> | null>()
			for (const line of affordable) {
				// Same routing as buyItem, for both kinds of line: a Gift block sends the item (and
				// its box) to another player while the caller pays, a named gift shows the sender,
				// and a self-buy or an anonymous gift is attributed to the "Coach" system account.
				const gift = line.gift
				// Annotated: without it the inference of this handler's own type runs through the
				// hub call below and back, and tsc gives up on the initializer (TS7022).
				const receiverId: number = lineReceiver(gift, id)
				const fromPlayerId = gift !== null && gift.Anonymous !== true ? id : COACH_ACCOUNT_ID
				const message = giftMessage(gift)
				const giftContext = Number.isInteger(gift?.GiftContext)
					? (gift?.GiftContext as number)
					: null
				if (line.kind === 'custom') {
					// A custom item is a SALE between players, settled the way buyInvention settles
					// one: the buyer's share of the bag was debited above, so record ownership first
					// (a buyer who paid and got the item but left the creator unpaid is recoverable;
					// a buyer charged for nothing is not), then pay the creator the item's price.
					// The creator's signup grant is seeded BEFORE crediting them: `creditCurrency`
					// upserts the balance row, and `ensureStartingBalances` is an INSERT OR IGNORE,
					// so a creator who had never touched their balance would otherwise have the row
					// created here and lose their starting tokens forever. The creator is a
					// different, probably-online player with no response to read, so the sale is
					// pushed as a plain update carrying their RESULTING total (what `creditCurrency`
					// returns) — sending the payout would set their whole balance to it.
					await grantCustomAvatarItem(c.env.DB, receiverId, line.custom.CustomAvatarItemId)
					if (line.price > 0) {
						const creatorId = line.custom.CreatorAccountId
						await ensureStartingBalances(c.env.DB, creatorId, startingTokens)
						const creatorBalance = await creditCurrency(
							c.env.DB,
							creatorId,
							currencyType as number,
							line.price,
							startingTokens
						)
						await pushBalanceUpdate(c, creatorId, currencyType as number, creatorBalance)
					}
					// Wrapped like any purchase: a box naming the item by `CustomAvatarItemId`, which
					// the client opens to show what was bought — in the receiver's gifts, announced to
					// them when that is someone else, as a catalog line's is. Ownership was granted
					// above, so the box is cosmetic and `BypassGiftPackages` skips it exactly as it
					// does a catalog line's. The entry below also carries the item record itself.
					if (skipGiftBox) {
						packages.set(line, null)
						continue
					}
					const content = toCustomGiftContent(line.custom, message, fromPlayerId, giftContext)
					const box = await createGift(c.env.DB, receiverId, content)
					if (receiverId !== id) {
						await pushCustomGiftReceived(c, receiverId, box.id, content)
					}
					packages.set(line, toCustomGiftPackage(box.id, receiverId, content))
					continue
				}
				// One box per requested item, holding all `count` copies — the wire has one
				// `GiftPackage` per entry, and only a consumable can be asked for more than once
				// (`resolveBulkLine` refuses a bigger count on anything owned once).
				const granted = await grantGiftDrop(c, receiverId, line.item.GiftDrop, message, {
					rollCatalog,
					skipGiftBox,
					copies: line.count,
					fromPlayerId,
					giftContext,
				})
				// The bag's own response carries only the buyer's boxes, so a gifted line is
				// announced to its receiver the same way buyItem's is. `BypassGiftPackages` skipped
				// the box entirely, and there is nothing to announce.
				if (receiverId !== id && !skipGiftBox) {
					await pushGiftReceived(c, receiverId, granted, message, fromPlayerId, giftContext)
				}
				// Une ligne du panier qui est l'abonnement le pose comme buyItem le ferait.
				if (line.item.PurchasableItemId === REC_BLUE_PLUS_ITEM_ID) {
					await grantRecBluePlus(c, receiverId)
				}
				const bundle = REC_BLUE_BUNDLES[line.item.PurchasableItemId]
				if (bundle !== undefined) {
					await grantRecBlueBundle(c, receiverId, bundle)
				}
				packages.set(
					line,
					// Null under `BypassGiftPackages`, which is the flag asking for exactly that —
					// the item is granted either way.
					skipGiftBox
						? null
						: toGiftPackage(granted, receiverId, fromPlayerId, message, giftContext)
				)
			}

			// One entry per REQUESTED item, in request order — the failures included, which is
			// where a partial bag says what it left behind.
			const updates = resolved.map((line) => {
				if (!isBulkLine(line)) {
					return {
						UpdateResponse: line.code,
						Data: {
							GiftPackage: null,
							PurchasableItemId: line.method.NumberId,
							CustomAvatarItem: null,
						} satisfies BulkPurchaseData,
					}
				}
				const sold = bought.has(line)
				return {
					UpdateResponse: sold ? UpdateResponse.OK : UpdateResponse.NotEnoughCredit,
					Data: {
						GiftPackage: packages.get(line) ?? null,
						PurchasableItemId: line.method.NumberId,
						CustomAvatarItem: sold && line.kind === 'custom' ? line.custom : null,
					} satisfies BulkPurchaseData,
				}
			})

			// One frame for the whole bag, not one per line: it SETS the account-wide bucket to the
			// resulting total read back from D1, so it agrees with the `Value.Balance` below and
			// with a `GET /balance` re-fetch instead of compounding — see the frame rule above
			// pushBalanceUpdate. Nothing moved on a free bag, so nothing is sent and the balance
			// read for the affordability check above still stands.
			let newBalance = balance
			if (total > 0) {
				newBalance = await getBalance(c.env.DB, id, currencyType as number, startingTokens)
				await pushBalancePurchase(c, id, currencyType as number, -total, newBalance)
			}
			return c.json({
				Success: true,
				Error: null,
				error_id: null,
				Value: {
					// The RESULTING total, unlike buyItem's change — and the bucket it belongs to.
					// `Platform` here is the client's `BalanceType` under a [DataMember] rename. A
					// capture from the reference server says 4 (RecNetPurchased) because it kept a
					// wallet per store; this server keeps ONE account-wide bucket, and the client SUMS
					// its buckets, so naming any other platform invents a second balance beside the
					// real one. See the frame rule above pushBalanceUpdate.
					Balance: newBalance,
					CurrencyType: currencyType,
					Platform: ALL_PLATFORMS,
					BalanceUpdates: updates,
				},
			})
		}
	)

	// Buy an invention. [Authorize]. A GET, despite being a purchase — the 2023 client sends
	// `?inventionId=…&requestedPrice=…` with no body, so that’s what we answer, in the v6 save
	// envelope that build reads. The 2025 build posts to `v3/buyInvention` below and wants a
	// different envelope back; the two share {@link settleInventionPurchase}, which is where
	// the money and the rules live, and build their own bodies from what it returns.
	.get(
		'/api/storefronts/v2/buyInvention',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy an invention',
			description: [
				'Looks the invention up by id, confirms the client’s `requestedPrice` still matches',
				'its stored `Price`, debits the buyer and pays the creator that price in',
				'RecCenterTokens (a free invention moves nothing), records ownership in',
				'`inventory_invention`, and returns the invention alongside the buyer’s resulting',
				'balance. When tokens moved, both players get a socket push carrying their RESULTING',
				'total — the buyer a StorefrontBalancePurchase, the CREATOR a StorefrontBalanceUpdate —',
				'which sets the account-wide bucket their client shows, agreeing with this body.',
				'A GET because that is how the client sends it.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'inventionId',
					in: 'query',
					required: true,
					description: 'Invention id; missing or non-numeric is 400',
					schema: { type: 'integer' },
				},
				{
					name: 'requestedPrice',
					in: 'query',
					required: false,
					description: 'The price the client rendered; a mismatch is 409. Defaults to 0',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(BuyInventionResponse, 'The purchase result (invention + balance)'),
				400: json(
					ErrorResponse,
					'Missing/non-numeric inventionId, buying your own, or insufficient balance'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'The invention is not published, so it is not for sale'),
				404: json(ErrorResponse, 'No such invention'),
				409: json(ErrorResponse, 'Already owned, or the price has changed'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const inventionId = Number.parseInt(c.req.query('inventionId') ?? '', 10)
			if (Number.isNaN(inventionId)) return c.json({ error: 'inventionId is required' }, 400)
			// Absent/non-numeric requestedPrice reads as 0, which only matches a free invention —
			// a priced one then fails the confirmation below rather than selling for nothing.
			const requestedPrice = Number.parseInt(c.req.query('requestedPrice') ?? '0', 10) || 0

			const settled = await settleInventionPurchase(c, id, inventionId, requestedPrice)
			if (settled instanceof Response) return settled

			return c.json({
				BalanceUpdateResponse: {
					Balance: settled.balance,
					BalanceType: ALL_PLATFORMS,
					CurrencyType: CurrencyType.RecCenterTokens,
					BalanceUpdates: [{ UpdateResponse: 0, Data: settled.invention }],
				},
				// The bare `{ Status, Invention, InventionVersion }` the v6 save serves — this
				// build's invention endpoints answer in it, and the client re-renders from it.
				InventionResponse: toSaveResult(settled.invention),
			})
		}
	)

	// Buy an invention, the way the 2025 client asks for it. [Authorize]. A POST carrying
	// `{ InventionId, RequestedPrice }` as JSON, where the v2 GET takes query params.
	//
	// The PURCHASE is identical — both settle through `settleInventionPurchase` — but the
	// RESPONSE is not, and that is the whole reason this route exists rather than an alias:
	// this build wraps the invention in the v9 save envelope and names its balance bucket
	// `Platform`. See `BuyInventionV3Response`. Both routes stay served: the 2023 build still
	// sends the GET, and it would not parse this body.
	.post(
		'/api/storefronts/v3/buyInvention',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy an invention (JSON body)',
			description: [
				'The same purchase as `GET /api/storefronts/v2/buyInvention` — confirms the client’s',
				'`RequestedPrice` still matches the invention’s stored `Price`, debits the buyer and',
				'pays the creator that price in RecCenterTokens (a free invention moves nothing),',
				'records ownership in `inventory_invention`, and pushes both players a socket frame',
				'carrying their RESULTING total — but answered in a DIFFERENT envelope, which is why',
				'the route exists at all: `InventionResponse` is the v9 save’s',
				'`{ Value, Success, Error, error_id }` (its `InventionVersion` and `TagsResponse` null,',
				'since a buy mints neither) and the balance half names its bucket `Platform`, not v2’s',
				'`BalanceType`.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(BuyInventionRequest, 'The invention id and the price rendered'),
			responses: {
				200: json(BuyInventionV3Response, 'The purchase result (invention + balance)'),
				400: json(
					ErrorResponse,
					'Invalid body, missing InventionId, buying your own, or insufficient balance'
				),
				401: UNAUTHORIZED_RESPONSE,
				403: json(ErrorResponse, 'The invention is not published, so it is not for sale'),
				404: json(ErrorResponse, 'No such invention'),
				409: json(ErrorResponse, 'Already owned, or the price has changed'),
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				return c.json({ error: 'Invalid request body' }, 400)
			}
			const inventionId = body.InventionId
			if (!Number.isInteger(inventionId)) {
				return c.json({ error: 'InventionId is required' }, 400)
			}
			// Read the same way as v2’s query param: an absent or non-integer RequestedPrice is 0,
			// which only matches a free invention — a priced one then fails the confirmation rather
			// than selling for nothing.
			const requestedPrice = Number.isInteger(body.RequestedPrice)
				? (body.RequestedPrice as number)
				: 0

			const settled = await settleInventionPurchase(c, id, inventionId as number, requestedPrice)
			if (settled instanceof Response) return settled

			return c.json({
				// The v9 SAVE envelope, not v6's bare `{ Status, Invention, InventionVersion }`:
				// `Value` under `{ Success, Error, error_id }`, with `Invention` the client's 28-key
				// `RRInvention`. A buy mints no version and takes no tags, so both of those keys are
				// present and NULL — which is safe here for the same reason it is on the save: the
				// client reads `Success` and `Value.Invention` and nothing else. `Value` itself must
				// never be null under `Success: true` — that dereference is what crashes it.
				InventionResponse: {
					Value: {
						Status: 0,
						Invention: toInventionV9(settled.invention),
						InventionVersion: null,
						TagsResponse: null,
					},
					Success: true,
					Error: null,
					error_id: null,
				},
				// `BalanceResponseDTO`, the same one the bulk purchase answers in — so the bucket key
				// is `Platform`, NOT the `BalanceType` the v2 body sends. The client's member IS named
				// `BalanceType`, but it carries a [DataMember] rename to `Platform` and its decoder
				// drops what it doesn't know, so spelling it `BalanceType` here would land this balance
				// in bucket 0 beside the real one. `Balance` is the RESULTING total, as in v2.
				BalanceUpdateResponse: {
					BalanceUpdates: [{ UpdateResponse: 0, Data: toInventionV9(settled.invention) }],
					Balance: settled.balance,
					CurrencyType: CurrencyType.RecCenterTokens,
					// The capture says 0 (SteamPurchased) because the reference server kept a wallet per
					// platform. This one keeps ONE bucket and the client SUMS them, so naming 0 here
					// while every socket frame names -2 is exactly the phantom second balance that
					// doubled players' tokens twice before. -2, like every other surface.
					Platform: ALL_PLATFORMS,
				},
			})
		}
	)

	// Storefront ad-carousel items. Served from the bundled static JSON — one
	// placeholder banner with no purchasable items until real promo data exists.
	.get(
		'/api/storefronts/v1/adcarouselitems',
		listRoute('Storefront ad-carousel items', 'The bundled carousel (one placeholder banner)'),
		(c) => c.json(adCarouselItems)
	)

	// Current weekly challenge. The rotation is GENERATED from the calendar week (see
	// challenge-rotation.ts — the same five challenges, window and gift for everyone, derived
	// from the week index; static/weekly-challenge.json pins it instead when it carries
	// challenges), but each challenge's state is per-player, so the caller's rows from
	// `challenge_status` are stamped over the week's: `Complete` over the published `false`,
	// and `Config` over the published rule tree — the client evaluates that tree locally and
	// reports it back with its running counts written into it (`cc`/`c`), so serving the
	// pristine tree back is what makes partial progress reset every session.
	// Auth is OPTIONAL: without a valid bearer the week is served unstamped rather than 401,
	// since the rotation is public information and a 404/401 on this route can stall the
	// client's load orchestration.
	.get(
		'/api/challenge/v2/getCurrent',
		describeRoute({
			tags: ['Econ'],
			summary: 'Current weekly challenge',
			description: [
				'This week’s rotation — generated from the calendar week — with each challenge’s',
				'`Complete` and `Config` stamped from the caller’s progress rows, the stored `Config`',
				'carrying the client’s running counts. Auth is optional: unauthenticated callers get',
				'the week unstamped, every `Complete` false and every `Config` as published.',
			].join(' '),
			security: OPTIONAL_AUTHED,
			responses: { 200: json(JsonObject, 'The current weekly challenge') },
		}),
		async (c) => {
			const rotation = withWeeklyGift(buildRotation(new Date()), await loadEquipmentGiftPool(c))
			const id = await authedId(c)
			if (id === null) return c.json(rotation)
			const statuses = await getChallengeStatuses(c.env.DB, id, rotation.ChallengeMapId)
			if (statuses.size === 0) return c.json(rotation)
			// Rebuild rather than mutate: the generated rotation is cached module state shared
			// by every request this isolate serves, so stamping it in place would leak one
			// player's progress to the next caller.
			return c.json({
				...rotation,
				Challenges: rotation.Challenges.map((challenge) => {
					const status = statuses.get(challenge.ChallengeId)
					if (status === undefined) return challenge
					// A row with no stored tree (never reported one) keeps the authored `Config`;
					// overwriting it with null would hand the client a challenge it can't evaluate.
					return {
						...challenge,
						Complete: status.complete,
						Config: status.config ?? challenge.Config,
					}
				}),
			})
		}
	)

	// Report progress on a weekly challenge. [Authorize]. The client evaluates the
	// challenge's rule tree locally and posts ChallengeMapId/ChallengeId, that tree in
	// `Config`, and whether it now considers the challenge `Complete`. Both are persisted
	// (keyed by account + challenge): the posted tree is the catalog's definition with the
	// client's running counts written into it, so it is this player's progress, and
	// `getCurrent` serves it back in place of the authored tree. Echoes the identifying
	// fields back with the state the row now holds — which is not always what was posted,
	// since completion latches within a rotation and a report with no `Config` keeps the
	// stored tree.
	.post(
		'/api/challenge/v2/updateProgress',
		describeRoute({
			tags: ['Econ'],
			summary: 'Report weekly-challenge progress',
			description: [
				'Persists the reported completion and rule tree into `challenge_status`, keyed by',
				'account + challenge, so `getCurrent` can serve the player’s own progress back.',
				'Completion latches within a rotation and a report carrying no `Config` keeps the',
				'stored tree, so the echoed fields are the stored values, not the posted ones.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(ChallengeProgressRequest, 'Challenge ids + the evaluated rule tree'),
			responses: {
				200: json(ChallengeProgressResponse, 'Echoed fields with the stored completion'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req
				.json<{
					ChallengeMapId?: string | number
					ChallengeId?: string | number
					Config?: string
					Complete?: string | boolean
				}>()
				.catch(() => ({}) as Record<string, never>)
			const challengeMapId = Number(body.ChallengeMapId) || 0
			const challengeId = Number(body.ChallengeId) || 0
			const config = typeof body.Config === 'string' ? body.Config : null
			// Nothing to key a row on — echo the body back rather than writing a (0, 0) row.
			const stored =
				challengeId === 0
					? { complete: parseBool(body.Complete), config }
					: await recordChallengeProgress(c.env.DB, id, {
							challengeMapId,
							challengeId,
							complete: parseBool(body.Complete),
							config,
						})
			// This report may have been the last one of the set. Only a completing report on
			// the LIVE rotation can be — an old rotation's set can no longer be finished, and
			// an unfinished challenge means the set isn't either, so neither is worth a read.
			// The response is unchanged whether or not a gift was won: the client learns about
			// the box from `GET /api/avatar/v2/gifts`, and adding a field here would be
			// inventing response shape the client never sent us.
			if (stored.complete && challengeId !== 0 && challengeMapId === rotationMapId(new Date())) {
				await awardChallengeGift(c, id)
			}
			return c.json({
				ChallengeMapId: challengeMapId,
				ChallengeId: challengeId,
				Config: stored.config ?? '',
				Complete: stored.complete,
			})
		}
	)

	// Pending game rewards. Returns "[]".
	.get('/api/gamerewards/v1/pending', listRoute('Pending game rewards', 'Empty for now'), (c) =>
		c.json([])
	)

	// Request a game reward. [Authorize]. The client asks whenever it thinks one is due,
	// posting the type and the message to show for it (`rewardType=FirstActivityOfDay&
	// Message=First Game of the Day`, or `rewardType=PostGameActivity&Message=Activity
	// completed!&giftContext=Soccer`) — so whether a reward is actually OWED is decided
	// here, from `reward_status`: one claim per type per activity per hour, atomically —
	// except FirstActivityOfDay, one per player per 24h.
	//
	// A claim pays GAME_REWARD_XP into `progression` (up to GAME_REWARD_DAILY_XP_CAP per player
	// per rolling 24h, FirstActivityOfDay's on top) and hands over a gift box carrying that
	// XP, announced with the same GiftPackageReceivedImmediate frame the weekly gift uses —
	// the client posted the message to show, so the box wears it. An on-cooldown ask changes
	// nothing and pays nothing.
	//
	// The response stays `[]` either way. It is what the client already accepts, and the box
	// is how a reward is delivered, so there is no captured shape to put the payout in — the
	// reference answers its own (different, selection-based) flow with a success envelope,
	// not a list of rewards.
	//
	// `giftContext` (the activity, e.g. `Soccer`) is part of the cooldown key, so a player who
	// moves from Soccer to Paintball is owed another reward while a second Soccer match inside
	// the hour is not. An ask that sends no context keys on `''` — as FirstActivityOfDay always
	// does, being the player's first activity of the day, not each activity's.
	//
	// It also picks the PRIZE: a context that is a key of `static/quest-rewards.json`
	// (`Dodgeball`, `Quest_Goblin_S`, …) draws one of that activity's rewards — an avatar item
	// granted into the inventory, or Laser Tag's ticket payout — and the box carries it, with
	// the activity's own `GiftContext`. A context the table doesn't know gets the XP-only box.
	//
	// A `PostGameActivity`/`PostQuestActivity` claim also pays GAME_REWARD_TOKENS, up to
	// GAME_REWARD_DAILY_TOKEN_CAP per player per rolling 24h across every activity, and a
	// FirstActivityOfDay claim pays them on top of the cap — credited to the balance and
	// delivered in a second box of its own so the player sees what the tokens were for.
	.post(
		'/api/gamerewards/v1/request',
		describeRoute({
			tags: ['Econ'],
			summary: 'Request a game reward',
			description: [
				'Claims one reward of `rewardType` in `giftContext` per hour per player, recorded in',
				'`reward_status`. The cooldown is per (type, activity), so a different activity is',
				'owed another reward while the same one is not; an ask with no `giftContext` keys on',
				'the empty context. A `giftContext` that names an activity in `quest-rewards.json`',
				'(`Dodgeball`, `Quest_Goblin_S`, …) draws one of that activity’s rewards and grants it;',
				'any other claim pays XP only. A `PostGameActivity` or `PostQuestActivity` claim also',
				'pays 250 tokens, in a box of its own, up to 1250 per player per rolling 24 hours',
				'whatever the activity. `FirstActivityOfDay` is once per player per 24 hours, whatever',
				'the `giftContext`, and pays 250 tokens outside that cap. The reward rides in a gift',
				'box, so a claim and a rejected (on-cooldown) ask both answer `[]`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(GameRewardRequest, 'The reward type and its display message'),
			responses: {
				200: json(JsonArray, 'The rewards granted — always [] while the payload is stubbed'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const rewardType = typeof body.rewardType === 'string' ? body.rewardType : ''
			// No type, nothing to gate: don't write a row keyed on an empty string.
			if (rewardType === '') return c.json([])
			const giftContext = typeof body.giftContext === 'string' ? body.giftContext : ''
			// FirstActivityOfDay is the player's, not the activity's: claimed on the empty context
			// and a day's cooldown. Its prize is still picked from the activity that asked.
			const daily = rewardType === FIRST_ACTIVITY_OF_DAY
			const claimed = daily
				? await claimReward(c.env.DB, id, rewardType, '', new Date(), DAILY_REWARD_COOLDOWN_MS)
				: await claimReward(c.env.DB, id, rewardType, giftContext)
			// On cooldown: nothing was claimed, so nothing is paid and nothing is announced.
			if (claimed === null) return c.json([])
			const message =
				typeof body.Message === 'string' && body.Message !== ''
					? body.Message
					: DEFAULT_GAME_REWARD_MESSAGE
			// The XP draws on the player's daily allowance — FirstActivityOfDay's is a bonus on top,
			// its once-a-day claim being limit enough. Past the cap the claim pays no XP.
			const xpToday = daily
				? null
				: await claimAllowance(c.env.DB, id, '$xp', GAME_REWARD_XP, GAME_REWARD_DAILY_XP_CAP)
			const xp = daily || xpToday !== null ? GAME_REWARD_XP : 0
			// Bank the XP first: it is the reward, and the box is the wrapper the client shows.
			// A failure here must not leave a box promising XP that was never credited.
			const gained = xp > 0 ? await addXp(c.env.DB, id, xp) : null
			// An activity the reward table knows pays one of ITS rewards the player lacks — the
			// item rides in the box and is granted with it. Anything else gets the plain XP box.
			const questReward = await pickQuestReward(c.env.DB, id, giftContext)
			const itemKey = questReward?.AvatarItemDesc || questReward?.EquipmentModificationGuid
			const drop =
				questReward === null
					? toGameRewardDrop(xp)
					: toQuestRewardDrop(
							questReward,
							itemKey ? await getCatalogItem(c.env.DB, itemKey) : null,
							xp
						)
			// A currency reward (Laser Tag's tickets) is credited here: `grantGiftDrop` grants
			// items, not balances. Seed the signup grant first — `creditCurrency` upserts the
			// row, and a never-touched RecCenterTokens balance would otherwise lose it.
			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			if (drop.Currency > 0 && drop.CurrencyType !== CurrencyType.Invalid) {
				await ensureStartingBalances(c.env.DB, id, startingTokens)
				const balance = await creditCurrency(
					c.env.DB,
					id,
					drop.CurrencyType,
					drop.Currency,
					startingTokens
				)
				await pushBalanceUpdate(c, id, drop.CurrencyType, balance)
			}
			// A box with nothing in it — the XP capped and no item or currency to carry — is not
			// handed over at all.
			let rewardGiftId: number | null = null
			if (questReward !== null || xp > 0) {
				const granted = await grantGiftDrop(c, id, drop, message)
				await pushGiftReceived(c, id, granted, message, COACH_ACCOUNT_ID)
				rewardGiftId = granted.id
			}
			// The tokens ride in a second box — after the reward's own, so the player sees the
			// reward they asked for first — while the player's daily allowance has room. Same
			// order as the currency reward above: balance first, then the box that shows it.
			let tokensGiftId: number | null = null
			let tokensToday: number | null = null
			if (TOKEN_REWARD_TYPES.has(rewardType)) {
				tokensToday = await claimAllowance(
					c.env.DB,
					id,
					'$tokens',
					GAME_REWARD_TOKENS,
					GAME_REWARD_DAILY_TOKEN_CAP
				)
			}
			// FirstActivityOfDay's claim already held it to once a day: it pays without the cap.
			if (daily || tokensToday !== null) {
				const tokensDrop = toGameRewardTokensDrop()
				await ensureStartingBalances(c.env.DB, id, startingTokens)
				const tokenBalance = await creditCurrency(
					c.env.DB,
					id,
					tokensDrop.CurrencyType,
					tokensDrop.Currency,
					startingTokens
				)
				await pushBalanceUpdate(c, id, tokensDrop.CurrencyType, tokenBalance)
				const tokensGift = await grantGiftDrop(c, id, tokensDrop, GAME_REWARD_TOKENS_MESSAGE)
				await pushGiftReceived(c, id, tokensGift, GAME_REWARD_TOKENS_MESSAGE, COACH_ACCOUNT_ID)
				tokensGiftId = tokensGift.id
			}
			if (gained !== null) {
				// Every grant moves the bar, whether or not it crossed a level.
				await pushProgressionUpdate(c, id, gained.progression)
				// …and every level crossed is worth a box of its own tier.
				await grantLevelUpGifts(c, id, gained)
			}
			logger.info('game reward claimed', {
				accountId: id,
				rewardType,
				giftContext,
				grantCount: claimed,
				message,
				xp,
				xpToday,
				level: gained?.progression.Level,
				levelsGained: gained?.levelsGained,
				levelXp: gained?.progression.XP,
				giftId: rewardGiftId,
				tokens: tokensGiftId === null ? 0 : GAME_REWARD_TOKENS,
				tokensToday,
				tokensGiftId,
			})
			return c.json([])
		}
	)

	// The caller's room keys: every key they hold (`room_key_player`), across all rooms.
	.get(
		'/api/roomkeys/v1/mine',
		describeRoute({
			tags: ['Econ'],
			summary: 'The player’s room keys',
			description: [
				'Every key the caller holds — bought, awarded, or taken free as a room manager —',
				'across every room, oldest key first. No parameters.',
				'',
				'Each entry is the room key plus `IsGiftable` (false) and `Visibility` (0), with',
				'`ImageName` as "" rather than null when the key has no art — the shape observed',
				'from the live client, which differs from `/api/roomkeys/v1/room`’s.',
			].join('\n'),
			security: AUTHED,
			responses: {
				200: json(HeldRoomKeyDto.array(), 'The caller’s keys, oldest first'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await getHeldRoomKeys(c.env.DB, id))
		}
	)
	// The keys a room has listed. Public, like the room's currencies: a key is offered to
	// whoever walks up to the door it opens. A room with none, an unknown room and a missing
	// `roomId` are all the same empty list.
	.get(
		'/api/roomkeys/v1/room',
		describeRoute({
			tags: ['Econ'],
			summary: 'A room’s keys',
			description: [
				'Every key the room named by `roomId` has listed, oldest first.',
				'',
				'Public, like `GET /api/roomcurrencies/v1/currencies`. A room with none, an unknown',
				'room and a missing `roomId` are all the same empty list.',
			].join('\n'),
			parameters: [
				{
					name: 'roomId',
					in: 'query',
					required: false,
					description: 'The room whose keys to list',
					schema: { type: 'string' },
				},
			],
			responses: { 200: json(RoomKeyDto.array(), 'The room’s keys, oldest first') },
		}),
		async (c) => {
			const roomId = Number.parseInt(c.req.query('roomId') ?? '', 10)
			if (!Number.isInteger(roomId)) return c.json([])
			return c.json(await getRoomKeys(c.env.DB, roomId))
		}
	)

	// List a key for a room. Auth-gated (401) and gated to the room's creator or a co-owner
	// (403) — the same owner-level check the room-currency writes apply.
	.post(
		'/api/roomkeys/v1/create',
		describeRoute({
			tags: ['Econ'],
			summary: 'Create a room key',
			description: [
				'Lists a key for one room — its name, its description and its price. Form-encoded',
				'(`Type=Key&RoomId=1162&Name=my%20key&Description=…&Price=50`), optionally with a',
				'`PurchaseCurrencyId` naming one of the room’s own currencies to price it in.',
				'',
				'Gated to the room’s CREATOR or a CO-OWNER, like minting a currency. A valid token',
				'from anyone else is a 403. A key priced in tokens (no `PurchaseCurrencyId`) at a',
				'non-zero `Price` also needs Rec Room Plus (the token’s `rn.plus` claim); without it,',
				'403. A room-currency price does not.',
				'',
				'`Name` and `Description` are masked by the same word list as every other string a',
				'player types. A room may list at most 10 keys — the `RoomKeyConfig.MaxKeysPerRoom`',
				'the `api` config tells the client — and the eleventh is refused. `Price` is capped by',
				'what the key is priced in: 1000 in tokens, 1000000000 in a room currency.',
				'`PurchaseCurrencyId` absent or blank is tokens; otherwise it must be a currency of',
				'the key’s own room, as on `updateAll`.',
				'',
				'Answers `{ Status, RoomKey }` — `Status` 0 and the created key, as the live client',
				'reads it — not the `{ Value, Success, Error, error_id }` envelope the room-currency',
				'writes use. A recoverable refusal (an unusable `RoomId`, an empty `Name`, an unknown',
				'room, a full room, a `Price` over the limit, an unknown or foreign currency) is a 200 carrying a non-zero `Status` and a null `RoomKey`; only',
				'the auth gates answer with an HTTP status of their own.',
				'',
				'Pushes `LocalRoomKeyCreated` (120), carrying the same object, to everyone in the',
				'room and to the caller.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(CreateRoomKeyRequest, 'The key to list'),
			responses: {
				200: json(RoomKeyEnvelope, 'The key as created, or a refusal with a non-zero `Status`'),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description:
						'Not the room’s creator or a co-owner, or a token price without Rec Room Plus (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v : '')
			const int = (v: unknown, fallback: number): number => {
				const parsed = Number.parseInt(str(v), 10)
				return Number.isInteger(parsed) ? parsed : fallback
			}

			const roomId = int(body.RoomId, Number.NaN)
			if (!Number.isInteger(roomId)) return roomKeyEnvelope(c, null)
			const name = str(body.Name).trim()
			if (name === '') return roomKeyEnvelope(c, null)
			// A key cannot cost less than nothing.
			const price = Math.max(0, int(body.Price, 0))

			const canManage = await canManageRoomById(c.env.DB, roomId, accountId)
			if (canManage === null) return roomKeyEnvelope(c, null)
			if (!canManage) return c.body(null, 403)

			// Absent or blank is TOKENS; otherwise the key is sold in its own room's money, not
			// another's — the same rule `updateAll` applies.
			const postedCurrencyId = str(body.PurchaseCurrencyId).trim()
			let purchaseCurrencyId: string | null = null
			if (postedCurrencyId !== '') {
				const currency = await getRoomCurrency(c.env.DB, postedCurrencyId)
				if (!currency || currency.RoomId !== roomId) return roomKeyEnvelope(c, null)
				purchaseCurrencyId = currency.CurrencyId
			}

			const maxPrice =
				purchaseCurrencyId === null ? MAX_KEY_PRICE_TOKENS : MAX_KEY_PRICE_ROOM_CURRENCY
			if (price > maxPrice) return roomKeyEnvelope(c, null)
			// Selling for TOKENS is a Rec Room Plus perk (see `isSubscriber`). A room-currency
			// price, or a free key, is open to any room manager.
			if (purchaseCurrencyId === null && price !== 0 && !(await isSubscriber(c))) {
				return c.body(null, 403)
			}

			if ((await getRoomKeys(c.env.DB, roomId)).length >= MAX_KEYS_PER_ROOM) {
				return roomKeyEnvelope(c, null)
			}

			const key = await createRoomKey(c.env.DB, {
				RoomId: roomId,
				Type: str(body.Type).trim() || 'Key',
				Name: censorSwears(name),
				Description: censorSwears(str(body.Description)),
				Price: price,
				PurchaseCurrencyId: purchaseCurrencyId,
			})

			await pushRoomKeyCreated(c, key, accountId)
			return roomKeyEnvelope(c, key)
		}
	)

	// Buy a room key with tokens. A GET with query params — that is how the client sends it.
	// The key's price leaves the buyer and is paid to the room's owner; holding the key is a
	// `room_key_player` row. Every refusal is a 200 in the same shape, told apart by the
	// entry's `UpdateResponse` — only a missing token answers with a status of its own.
	.get(
		'/api/storefronts/v1/buyRoomKey',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a room key',
			description: [
				'Looks the key up by `RoomKeyId`, confirms the client’s `RequestedPrice` matches its',
				'stored `Price`, debits the buyer that price in RecCenterTokens, pays it to the',
				'room’s OWNER (its `CreatorAccountId`), and records the buyer as holding the key',
				'(`room_key_player`). A free key moves no tokens, and nor does a key bought by the',
				'room’s creator or a CO-OWNER: they get their own room’s keys free, and the client',
				'asks them `RequestedPrice=0` (the stored price is accepted too). A GET because that',
				'is how the client sends it.',
				'',
				'Answers the client’s `RoomKeyPurchaseResponseDTO`: `RoomKeyResponse` is the',
				'`{ Status, RoomKey }` the create answers in, and `BalanceUpdateResponse` carries one',
				'entry (`UpdateResponse`, `Data` = the key) and the buyer’s RESULTING `Balance`.',
				'`Platform` is -2, the one bucket every balance surface here names — any other value',
				'shows the buyer a phantom second balance.',
				'',
				'A refusal is a 200 in the same shape — `Status` 1, a null `RoomKey`, the balance',
				'untouched — with the reason in the entry’s `UpdateResponse`: 6 the price does not',
				'match, 3 already held, 2 not enough tokens, 4 no such key (or no such room, or a key',
				'priced in a ROOM CURRENCY, which this token route does not sell).',
				'',
				'When tokens moved, both players get a socket push carrying their resulting total —',
				'the buyer a StorefrontBalancePurchase, the owner a StorefrontBalanceUpdate.',
			].join('\n'),
			security: AUTHED,
			parameters: [
				{
					name: 'RoomKeyId',
					in: 'query',
					required: true,
					description: 'The key to buy — a `room_key` id',
					schema: { type: 'integer' },
				},
				{
					name: 'RequestedPrice',
					in: 'query',
					required: false,
					description: 'The price the client rendered; must equal the key’s. Defaults to 0',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(BuyRoomKeyResponse, 'The purchase result, or a refusal in the same shape'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
			const currencyType = CurrencyType.RecCenterTokens
			const roomKeyId = Number.parseInt(c.req.query('RoomKeyId') ?? '', 10)
			// Absent/non-numeric reads as 0, which only matches a free key — a priced one then
			// fails the confirmation below rather than selling for nothing.
			const requestedPrice = Number.parseInt(c.req.query('RequestedPrice') ?? '0', 10) || 0
			const key = Number.isInteger(roomKeyId) ? await getRoomKey(c.env.DB, roomKeyId) : null

			// Every key is always sent: the client reads an omitted one as its enum's 0 member,
			// which is success for `Status`/`UpdateResponse` and SteamPurchased for `Platform`.
			const answer = async (code: number) =>
				c.json({
					RoomKeyResponse: {
						Status: code === UpdateResponse.OK ? ROOM_KEY_STATUS_OK : ROOM_KEY_STATUS_FAILED,
						RoomKey: code === UpdateResponse.OK ? key : null,
					},
					BalanceUpdateResponse: {
						BalanceUpdates: [{ UpdateResponse: code, Data: key }],
						Balance: await getBalance(c.env.DB, id, currencyType, startingTokens),
						CurrencyType: currencyType,
						Platform: ALL_PLATFORMS,
					},
				})

			// A key priced in a room currency is not for sale in tokens.
			if (key === null || key.PurchaseCurrencyId !== null) {
				return answer(UpdateResponse.NoItemAvailable)
			}
			const ownerId = await getRoomOwnerId(c.env.DB, key.RoomId)
			if (ownerId === null) return answer(UpdateResponse.NoItemAvailable)
			// The room's creator and co-owners get their own room's keys free — the client asks
			// them `RequestedPrice=0` — and are never charged, whatever price they name.
			const canManage = (await canManageRoomById(c.env.DB, key.RoomId, id)) === true
			if (requestedPrice !== key.Price && !(canManage && requestedPrice === 0)) {
				return answer(UpdateResponse.RequestedPriceDoesNotMatch)
			}

			// Claim the key BEFORE charging: the insert is atomic, so of two concurrent buys only
			// one gets past here and only one is charged. A buyer who cannot pay gives it back.
			if (!(await claimRoomKey(c.env.DB, id, key.RoomKeyId))) {
				return answer(UpdateResponse.AlreadyOwned)
			}
			if (key.Price > 0 && !canManage) {
				if (!(await spendCurrency(c.env.DB, id, currencyType, key.Price, startingTokens))) {
					await releaseRoomKey(c.env.DB, id, key.RoomKeyId)
					return answer(UpdateResponse.NotEnoughCredit)
				}
				// Seed the owner's signup grant BEFORE crediting them — `creditCurrency` upserts
				// the row, which would otherwise cost a never-seen owner their starting tokens.
				await ensureStartingBalances(c.env.DB, ownerId, startingTokens)
				const ownerBalance = await creditCurrency(
					c.env.DB,
					ownerId,
					currencyType,
					key.Price,
					startingTokens
				)
				// Both frames carry a RESULTING total — see the frame rule above pushBalanceUpdate.
				await pushBalanceUpdate(c, ownerId, currencyType, ownerBalance)
				await pushBalancePurchase(
					c,
					id,
					currencyType,
					-key.Price,
					await getBalance(c.env.DB, id, currencyType, startingTokens)
				)
			}

			return answer(UpdateResponse.OK)
		}
	)

	// Buy a room key with the room currency it is priced in — buyRoomKey's mirror image, and
	// almost nothing shared on the wire: a POST with a form body, a bare `{ Balance,
	// RoomKeyResponse }`, and a `Balance` that is an OBJECT. Nobody is paid: room currency is
	// the room's own play money, so the price simply leaves the buyer.
	.post(
		'/api/storefronts/v1/PurchaseRoomKeyWithCurrency',
		describeRoute({
			tags: ['Storefront'],
			summary: 'Buy a room key with room currency',
			description: [
				'Buys a key priced in a room currency. Form-encoded',
				'(`RoomKeyId=43&RequestedPrice=1000&RequestedPurchaseCurrencyId=b9f41a7c-…`): the',
				'key’s `Price` is subtracted from what the caller holds of that currency',
				'(`room_balance`) and they are recorded as holding the key (`room_key_player`).',
				'NOBODY IS PAID — unlike the token sale, the price does not reach the room’s owner.',
				'',
				'`RequestedPurchaseCurrencyId` must be the key’s own `PurchaseCurrencyId` and',
				'`RequestedPrice` its `Price` — except that the room’s creator or a CO-OWNER gets',
				'their own room’s keys free: the client asks them `RequestedPrice=0` (the stored',
				'price is accepted too) and nothing is subtracted.',
				'A key priced in TOKENS (a null `PurchaseCurrencyId`)',
				'is not sold here — that is `GET /api/storefronts/v1/buyRoomKey`.',
				'',
				'Answers the client’s `RoomKeyPurchaseWithCurrencyResponseDTO`, a bare object with no',
				'envelope: `Balance` is an OBJECT — `{ AccountId, CurrencyId, Balance, ModifiedAt }`,',
				'the buyer’s RESULTING holding — and `RoomKeyResponse` the `{ Status, RoomKey }` the',
				'create answers in. Not buyRoomKey’s shape; there is no `Platform` here.',
				'',
				'A refusal (no such key, a currency or price that is not the key’s, a key already',
				'held, too little of the currency) is a 200 in the same shape: `Status` 1, a null',
				'`RoomKey`, and the holding as it stands. That form is an assumption — only success',
				'has been observed.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(PurchaseRoomKeyWithCurrencyRequest, 'The key, and what the client saw'),
			responses: {
				200: json(
					PurchaseRoomKeyWithCurrencyResponse,
					'The purchase result, or a refusal in the same shape'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
			const int = (v: unknown): number => (/^-?\d+$/.test(str(v)) ? Number(str(v)) : Number.NaN)

			const requestedCurrencyId = str(body.RequestedPurchaseCurrencyId)
			const roomKeyId = int(body.RoomKeyId)
			const key = Number.isInteger(roomKeyId) ? await getRoomKey(c.env.DB, roomKeyId) : null
			// The currency the answer reports on: the key's own once it is known to be the one
			// asked for, the requested one on a refusal that never got that far.
			const currencyId = key?.PurchaseCurrencyId ?? requestedCurrencyId

			// `Status` is always sent: the client reads an omitted one as 0, which is success.
			const answer = async (sold: boolean) =>
				c.json({
					Balance: {
						AccountId: id,
						CurrencyId: currencyId,
						Balance: await getRoomBalance(c.env.DB, currencyId, id),
						ModifiedAt: new Date().toISOString(),
					},
					RoomKeyResponse: {
						Status: sold ? ROOM_KEY_STATUS_OK : ROOM_KEY_STATUS_FAILED,
						RoomKey: sold ? key : null,
					},
				})

			// A key priced in tokens is buyRoomKey's to sell, and a key is paid for in its own
			// currency only — never whichever one the request would rather spend.
			if (key === null || key.PurchaseCurrencyId === null) return answer(false)
			if (requestedCurrencyId.toLowerCase() !== key.PurchaseCurrencyId.toLowerCase()) {
				return answer(false)
			}
			// The room's creator and co-owners get their own room's keys free, as with the token
			// sale — the client asks them `RequestedPrice=0` — and are never charged.
			const canManage = await canManageRoomById(c.env.DB, key.RoomId, id)
			if (canManage === null) return answer(false)
			const requestedPrice = int(body.RequestedPrice)
			if (requestedPrice !== key.Price && !(canManage && requestedPrice === 0)) {
				return answer(false)
			}

			// Claim the key BEFORE charging, as the token sale does: the insert is atomic, so of
			// two concurrent buys only one is charged. A buyer who cannot pay gives it back.
			if (!(await claimRoomKey(c.env.DB, id, key.RoomKeyId))) return answer(false)
			if (
				key.Price > 0 &&
				!canManage &&
				!(await spendRoomCurrency(c.env.DB, key.PurchaseCurrencyId, id, key.Price))
			) {
				await releaseRoomKey(c.env.DB, id, key.RoomKeyId)
				return answer(false)
			}

			return answer(true)
		}
	)

	// Edit a room key. "All" is the key's FIELDS, not the room's keys: the body names one
	// `RoomKeyId` and carries everything editable about it. Gated like the create — the room
	// comes off the KEY, never the request.
	.put(
		'/api/roomkeys/v1/updateAll',
		describeRoute({
			tags: ['Econ'],
			summary: 'Update a room key',
			description: [
				'Edits ONE key — despite the name, "all" is its fields — form-encoded',
				'(`RoomKeyId=43&Name=key1&Description=…&Price=1000&PurchaseCurrencyId=`).',
				'',
				'Gated to the CREATOR or a CO-OWNER of the room that lists the key; a valid token',
				'from anyone else is a 403. A key that ends up priced in tokens at a non-zero `Price`',
				'also needs Rec Room Plus (the token’s `rn.plus` claim); without it, 403. A room',
				'currency price does not.',
				'',
				'`PurchaseCurrencyId` sent EMPTY prices the key in tokens (stored and served as',
				'null) — that is how a key on a room currency is taken back off it; otherwise it',
				'must be a `room_currency` id belonging to the key’s own room.',
				'`ImageName` is the key’s art, stored as posted; sent EMPTY it clears the art',
				'(served as null). That `ImageName` rides in this form is an ASSUMPTION.',
				'`Price` is capped by what the key ends up priced in: 1000 in tokens, 1000000000 in',
				'a room currency. A field left out of the body is left alone rather than reset, and',
				'the cap is checked against the resulting pair.',
				'',
				'`Name` and `Description` are masked by the same word list as every other string a',
				'player types. What can never change: the ids, the room, the `Type`, `CreatedAt`.',
				'',
				'Answers the create’s `{ Status, RoomKey }` envelope with the key as it now stands',
				'— an ASSUMPTION: what the client reads from this response has not been observed.',
				'A recoverable refusal (no such key, a blank `Name`, a `Price` over the cap, an',
				'unknown or foreign currency) is a 200 carrying a non-zero `Status` and a null',
				'`RoomKey`.',
			].join('\n'),
			security: AUTHED,
			requestBody: form(UpdateRoomKeyRequest, 'The key and its fields'),
			responses: {
				200: json(RoomKeyEnvelope, 'The key as it now stands, or a refusal'),
				401: UNAUTHORIZED_RESPONSE,
				403: {
					description:
						'Not the room’s creator or a co-owner, or a token price without Rec Room Plus (empty body)',
				},
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

			const roomKeyId = Number.parseInt(str(body.RoomKeyId) ?? '', 10)
			if (!Number.isInteger(roomKeyId)) return roomKeyEnvelope(c, null)

			const existing = await getRoomKey(c.env.DB, roomKeyId)
			if (!existing) return roomKeyEnvelope(c, null)

			const canManage = await canManageRoomById(c.env.DB, existing.RoomId, accountId)
			if (canManage === null) return roomKeyEnvelope(c, null)
			if (!canManage) return c.body(null, 403)

			// A name sent but blank is a bad edit, not an instruction to leave it alone.
			const name = str(body.Name)?.trim()
			if (name === '') return roomKeyEnvelope(c, null)

			let price = existing.Price
			if (str(body.Price) !== undefined) {
				price = Number.parseInt(str(body.Price)!, 10)
				if (!Number.isInteger(price) || price < 0) return roomKeyEnvelope(c, null)
			}

			// Present-but-empty is a VALUE here — tokens — unlike the fields above, where only
			// absence means "leave alone".
			let purchaseCurrencyId = existing.PurchaseCurrencyId
			const postedCurrencyId = str(body.PurchaseCurrencyId)?.trim()
			if (postedCurrencyId === '') {
				purchaseCurrencyId = null
			} else if (postedCurrencyId !== undefined && postedCurrencyId !== purchaseCurrencyId) {
				// A key is sold in its own room's money, not another's.
				const currency = await getRoomCurrency(c.env.DB, postedCurrencyId)
				if (!currency || currency.RoomId !== existing.RoomId) return roomKeyEnvelope(c, null)
				purchaseCurrencyId = currency.CurrencyId
			}

			const maxPrice =
				purchaseCurrencyId === null ? MAX_KEY_PRICE_TOKENS : MAX_KEY_PRICE_ROOM_CURRENCY
			if (price > maxPrice) return roomKeyEnvelope(c, null)
			// Judged on the RESULTING pair, like the cap: a token price is a Rec Room Plus perk
			// (see `isSubscriber`), so an edit that leaves or puts a key on tokens at a non-zero
			// price needs Plus. A room-currency price, or a free key, does not.
			if (purchaseCurrencyId === null && price !== 0 && !(await isSubscriber(c))) {
				return c.body(null, 403)
			}

			// Blank is a value here too: no art. Only absence leaves the stored name alone.
			const postedImageName = str(body.ImageName)?.trim()
			const imageName = postedImageName === undefined ? existing.ImageName : postedImageName || null

			const description = str(body.Description)
			return roomKeyEnvelope(
				c,
				await updateRoomKey(c.env.DB, roomKeyId, {
					Name: name === undefined ? existing.Name : censorSwears(name),
					Description: description === undefined ? existing.Description : censorSwears(description),
					Price: price,
					PurchaseCurrencyId: purchaseCurrencyId,
					ImageName: imageName,
				})
			)
		}
	)

	// Award the CALLER some room keys. Auth-gated (401); everything else is reported per
	// entry, each in its OWN `{ Value, Success, Error, error_id }` envelope — the client
	// decodes a list of single-value envelopes here. The body is a bare array of `{ RoomKeyId,
	// AccountId }` — `AccountId` is accepted and unused: the token says who gets the key.
	.post(
		'/api/roomkeys/v1/awardbulk',
		describeRoute({
			tags: ['Econ'],
			summary: 'Award room keys to the caller',
			description: [
				'Records the CALLER as holding each key the body names (`room_key_player`). The body',
				'is a BARE JSON ARRAY, `[{ "RoomKeyId": 43, "AccountId": 205 }]`; `AccountId` is',
				'accepted and IGNORED — the token says who is awarded.',
				'',
				'A key is held or it isn’t: awarding one the caller already holds succeeds and',
				'changes nothing.',
				'',
				'The answer is an ARRAY OF ENVELOPES — one `{ Value, Success, Error, error_id }` per',
				'entry, in the order posted, as the client’s decoder reads it; not a bare array of',
				'awards, and not one envelope around a list. `Value` is `{ RoomKeyId, AccountId }`,',
				'`AccountId` being the caller. Each entry stands alone: a `RoomKeyId` naming no listed',
				'key answers `Success` false with a null `Value` (the failure form is an assumption —',
				'only success has been observed) and leaves the rest to land.',
				'',
				'NOTE: this awards to whoever is asking, and nothing is spent for it — the key’s',
				'`Price` is not charged and no room membership is checked.',
			].join('\n'),
			security: AUTHED,
			requestBody: jsonBody(AwardRoomKeysRequest, 'The keys to give the caller'),
			responses: {
				200: json(AwardRoomKeyResultList, 'One result per entry, in the order posted'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = await c.req.json<unknown>().catch(() => null)
			// A body that is no list has no entries to report on.
			if (!Array.isArray(body)) return c.json([])

			const failed = (error: string) => ({
				Value: null,
				Success: false,
				Error: error,
				error_id: null,
			})
			const results = []
			for (const entry of body as unknown[]) {
				const roomKeyId =
					typeof entry === 'object' && entry !== null
						? (entry as { RoomKeyId?: unknown }).RoomKeyId
						: undefined
				if (typeof roomKeyId !== 'number' || !Number.isInteger(roomKeyId)) {
					results.push(failed('Invalid room key'))
					continue
				}

				const awardedAt = await awardRoomKey(c.env.DB, accountId, roomKeyId)
				results.push(
					awardedAt === null
						? failed('No such room key')
						: {
								Value: { RoomKeyId: roomKeyId, AccountId: accountId },
								Success: true,
								Error: null,
								error_id: null,
							}
				)
			}

			return c.json(results)
		}
	)

	// Who holds which room key. Auth-gated (401). The body is a bare array of `{ AccountId,
	// RoomKeyId }` pairs and — unlike the award's — `AccountId` is READ here: a room asks
	// about the players standing in it, not only the caller. A bare array back, one answer
	// per pair.
	.post(
		'/api/roomkeys/v1/owns/bulk',
		describeRoute({
			tags: ['Econ'],
			summary: 'Whether players hold room keys',
			description: [
				'Answers, for each `{ AccountId, RoomKeyId }` pair posted, whether that player holds',
				'that key (`room_key_player`). The body is a BARE JSON ARRAY, and so is the answer:',
				'`[{ "AccountId": 205, "RoomKeyId": 43, "DoesPlayerOwnRoomKey": true }]`, one entry',
				'per pair in the order posted — no envelope, unlike the award beside it.',
				'',
				'`AccountId` is honoured, not replaced by the caller: any signed-in player may ask',
				'about any player. An unknown key or player is simply not held; an entry without two',
				'integer ids is skipped.',
			].join('\n'),
			security: AUTHED,
			requestBody: jsonBody(OwnsRoomKeysRequest, 'The (player, key) pairs to check'),
			responses: {
				200: json(OwnsRoomKeysResponse, 'One answer per pair, in the order posted'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const accountId = await authedId(c)
			if (accountId === null) return unauthorized(c)

			const body = await c.req.json<unknown>().catch(() => null)
			if (!Array.isArray(body)) return c.json([])

			const pairs: RoomKeyHolding[] = []
			for (const entry of body as unknown[]) {
				if (typeof entry !== 'object' || entry === null) continue
				const { AccountId, RoomKeyId } = entry as Record<string, unknown>
				if (typeof AccountId !== 'number' || !Number.isInteger(AccountId)) continue
				if (typeof RoomKeyId !== 'number' || !Number.isInteger(RoomKeyId)) continue
				pairs.push({ AccountId, RoomKeyId })
			}

			const owned = await ownsRoomKeys(c.env.DB, pairs)
			return c.json(pairs.map((pair, i) => ({ ...pair, DoesPlayerOwnRoomKey: owned[i] })))
		}
	)

	// The Rec Room Plus sign-up bonus: which bonus is running and the token price window
	// the free items are drawn from. Fixed numbers, the same for every caller.
	//
	// Unauthenticated, like the subscription lookup below and for the same reason: the
	// client reads this while putting the RR+ page together, nothing in the answer is
	// per-account, and a 401 would only be a way for that load to stall. (The `api` copy of
	// this path does validate a token, mirroring the reference server.)
	.get(
		'/api/CampusCard/v1/SignUpBonus',
		describeRoute({
			tags: ['Econ'],
			summary: 'Rec Room Plus sign-up bonus',
			description: [
				'The bonus a player gets for taking out Rec Room Plus: which bonus is running',
				'(`RRPlusSignUpBonusId`) and the token price window the free items are picked from.',
				'Fixed values — nothing here is per-account or stored, so no auth is required and',
				'every caller gets the same three numbers.',
			].join(' '),
			responses: { 200: json(RRPlusSignUpBonus, 'The running sign-up bonus') },
		}),
		(c) =>
			c.json({
				RRPlusSignUpBonusId: 3,
				MinFreeItemsPrice: 6000,
				MaxFreeItemsPrice: 10000,
			})
	)

	// Subscription lookup (Rec Room Plus, the client's `CampusCard`). There is no store to
	// buy one from: Plus is claimed on the website by proving a Discord role, and reaches
	// this worker as the token's `rn.plus` claim. A caller carrying it reports an active
	// Gold year; everyone else reports none. Nothing about the subscription itself is
	// stored, and nothing here reads the database — see `isSubscriber` and `plusSubscription`.
	//
	// Auth is OPTIONAL, and a missing or invalid token answers "no subscription" rather than
	// 401: the client posts this while loading, so an error here can stall its load
	// orchestration, and "you aren't subscribed" is the truthful answer for an anonymous
	// caller anyway. Never read from the body.
	.post(
		'/api/CampusCard/v1/UpdateAndGetSubscription',
		describeRoute({
			tags: ['Econ'],
			summary: 'Subscription lookup',
			description: [
				'The caller’s Rec Room Plus subscription. Nothing sells subscriptions here: Plus is',
				'claimed on the website by proving a qualifying role in the community Discord, and',
				'arrives as the token’s `rn.plus` claim. A token carrying it reports an active Gold',
				'(`Level` 0) yearly (`Period` 1) subscription on `PlatformType` -1 (All), expiring a',
				'year from the call; every other caller gets `{}`. The `developer` role does NOT',
				'confer it. Auth is optional — a missing or invalid token reads as “not subscribed”,',
				'not 401. The subscription itself is not persisted. It also follows the account row,',
				'so a Plus granted on the website applies at the next call, without signing in again.',
			].join(' '),
			responses: {
				200: json(SubscriptionResponse, 'The subscription, or `{}` for no subscription'),
			},
		}),
		async (c) => {
			if (!(await isSubscriber(c))) return c.json({})
			const id = await authedId(c)
			if (id === null) return c.json({})
			const { readAccountFlags } = await import('./site-flags')
			const flags = await readAccountFlags(c.env.DB, id)
			return c.json({
				Subscription: plusSubscription(id, flags.plusUntil),
				PlatformAccountSubscribedPlayerId: null,
			})
		}
	)

	// The 2026 decoder requires an object; RecNet rejects JSON null as an empty response.
	.get(
		'/api/subscriptionseasons/v1/seasons/current',
		describeRoute({
			summary: 'Current subscription season',
			responses: {
				200: json(
					z.union([
						JsonArray,
						z.object({
							SubscriptionSeasonId: z.string().uuid(),
							Name: z.string(),
							ImageName: z.string(),
							StartAt: z.string(),
							NextSeasonStart: z.string().nullable(),
							Milestones: JsonArray,
						}),
					]),
					'2026: season object without milestones; older builds: []'
				),
			},
		}),
		async (c) =>
			c.json(
				((await authedBuild(c)) ?? 0) >= 20260323
					? {
							SubscriptionSeasonId: '00000000-0000-0000-0000-000000000000',
							Name: '',
							ImageName: '',
							StartAt: '0001-01-01T00:00:00Z',
							NextSeasonStart: null,
							Milestones: [],
						}
					: []
			)
	)

	// Whether the caller can start a Maker AI free trial. Always false, mirroring the
	// reference server: nothing here runs trials, and false is the answer that leaves the
	// client's creation UI in its normal state rather than offering a trial that can't
	// start. The body is a BARE JSON `false` — not an envelope, not `{ value: false }`.
	//
	// Auth-gated (401 on a missing or invalid token) even though the answer is the same for
	// everyone, because the reference validates the token before answering and eligibility
	// is a per-account question the moment anything does run trials.
	.get(
		'/api/makerai/checkfreetrialeligibility',
		describeRoute({
			tags: ['Econ'],
			summary: 'Maker AI free-trial eligibility',
			description: [
				'Whether the caller can start a Maker AI free trial. Always `false` — nothing here',
				'runs trials. The body is a bare JSON boolean, not an envelope.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(MakerAiFreeTrialEligibilityResponse, 'Always `false`'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(false)
		}
	)

	// The caller's progress through the refer-a-friend rewards: how many of their referrals
	// have been verified, and which rewards they have taken from that track.
	//
	// Nothing here runs a referral programme, so nobody has referred anybody: the count is 0
	// and the reward list is empty. That is a real answer rather than a stub — it is what a
	// player who has referred nobody sees — so the client draws an untouched track, which is
	// exactly the state this server is in.
	//
	// The payload is NESTED under `value`, unlike econ's flat balance bodies.
	.get(
		'/api/incentivizedreferrals/progress',
		describeRoute({
			tags: ['Econ'],
			summary: 'The caller’s referral-reward progress',
			description: [
				'How many of the caller’s referrals have been verified and which referral rewards they',
				'have claimed, under a `{ success, value }` envelope. Always 0 and empty — no referral',
				'programme runs here — which the client renders as an untouched reward track.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(ReferralProgressResponse, 'The caller’s progress — always zero'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json({
				success: true,
				value: { ReferralsVerifiedCount: 0, PlayerReferralRewards: [] },
			})
		}
	)

	// Everyone in the influencer partner program, by account id — the list the client keeps
	// so it can badge an influencer wherever they turn up, rather than asking per player.
	// Membership is the account's `isInfluencer` flag (`runx admin grant-influencer`), read
	// through the `is_influencer` generated column's partial index so the account table is
	// never scanned.
	//
	// Paged in shape only: the client asks for `take=1000` and this server will not have
	// that many, so the whole list is one page and `ContinuationToken` is always null. `take`
	// is accepted and ignored. Note this is the LIST counterpart of the single-account tier
	// check below, which still answers 0 for everyone.
	.get(
		'/api/influencerpartnerprogram/influencers',
		describeRoute({
			tags: ['Econ'],
			summary: 'Every influencer in the partner program',
			description: [
				'The account ids in the influencer partner program — every account flagged',
				'`isInfluencer` — as `{ InfluencerIds, ContinuationToken }`: an object around the',
				'list, not a bare array. Served whole: `take` is accepted and ignored, and',
				'`ContinuationToken` is always null.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'take',
					in: 'query',
					required: false,
					description: 'How many ids to return. Accepted and ignored — the list is served whole.',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(InfluencerIdsResponse, 'The influencer ids, lowest first'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const InfluencerIds = await listInfluencerIds(c.env.DB)
			return c.json({ InfluencerIds, ContinuationToken: null })
		}
	)

	// The influencer one account SUPPORTS in the partner program, by account id — every
	// player picks one (`…/support` below), and this is how anyone reads anyone's pick.
	//
	// A BARE NUMBER is the whole body, like `…/makerai/checkfreetrialeligibility`'s bare
	// `false`, not a number wrapped in an object; 0 is "supports nobody", which is also what
	// an account that does not exist answers. The caller's own pick is `…/myinfluencer`.
	.get(
		'/api/influencerpartnerprogram/influencer',
		describeRoute({
			tags: ['Econ'],
			summary: 'The influencer an account supports',
			description: [
				'The account id of the influencer the account named by `accountId` supports, as a',
				'BARE NUMBER — the whole body is the id, not an object around it; `0` when they',
				'support nobody (or no such account exists). Auth-gated; a missing or invalid token',
				'is a 401. A missing or non-numeric `accountId` is a 400.',
			].join(' '),
			security: AUTHED,
			parameters: [
				{
					name: 'accountId',
					in: 'query',
					required: true,
					description: 'The account being asked about.',
					schema: { type: 'integer' },
				},
			],
			responses: {
				200: json(SupportedInfluencerResponse, 'The supported influencer’s id, or 0'),
				400: { description: '`accountId` missing or not an integer (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const accountId = Number.parseInt(c.req.query('accountId') ?? '', 10)
			if (!Number.isInteger(accountId)) return c.body(null, 400)
			return c.json(await supportedInfluencer(c.env.DB, accountId))
		}
	)

	// The same question about the CALLER — the `my` form, which names no account because the
	// token already does. Same bare number, same 0 for nobody.
	//
	// Its own route rather than an alias of the one above, because the two differ in who they
	// are about.
	.get(
		'/api/influencerpartnerprogram/myinfluencer',
		describeRoute({
			tags: ['Econ'],
			summary: 'The influencer the caller supports',
			description: [
				'The account id of the influencer the caller supports — the `my` form of the route',
				'above, taking the account from the token rather than a query parameter. A BARE',
				'NUMBER; `0` when they support nobody. Auth-gated; a missing or invalid token is a 401.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(SupportedInfluencerResponse, 'The supported influencer’s id, or 0'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			return c.json(await supportedInfluencer(c.env.DB, id))
		}
	)

	// Pick the influencer the caller supports: `influencerAccountId=<id>`, form-encoded. ONE
	// per player, stored on the account as `supportedInfluencerId`; posting again replaces
	// the pick. The id has to name an account currently flagged `isInfluencer` — anything
	// else, the caller's own id included, is a 400 and changes nothing. The reply is a bare
	// `{ Success, Error, error_id }` status envelope — no `Value`: the client reads the pick
	// back from `…/myinfluencer` rather than from this reply.
	.post(
		'/api/influencerpartnerprogram/support',
		describeRoute({
			tags: ['Econ'],
			summary: 'Pick the influencer the caller supports',
			description: [
				'Set the ONE influencer the caller supports in the partner program, replacing any',
				'earlier pick. `influencerAccountId` must name an account that is currently an',
				'influencer (listed by `…/influencers`); the caller cannot support themselves. The',
				'reply is a `{ Success, Error, error_id }` status envelope with no `Value`; read the',
				'new pick back from `…/myinfluencer`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(SupportInfluencerBody, 'The influencer to support'),
			responses: {
				200: json(SupportInfluencerResponse, 'The pick was recorded'),
				400: {
					description:
						'`influencerAccountId` missing, not an integer, the caller’s own id, or not an influencer (empty body)',
				},
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const raw = body.influencerAccountId
			const influencerId = Number.parseInt(typeof raw === 'string' ? raw : '', 10)
			if (!Number.isInteger(influencerId) || influencerId === id) return c.body(null, 400)
			const influencer = await getAccount(c.env.DB, influencerId)
			if (influencer?.isInfluencer !== true) return c.body(null, 400)
			await updateAccount(c.env.DB, id, { supportedInfluencerId: influencerId })
			return c.json({ Success: true, Error: null, error_id: null })
		}
	)

	// Stop supporting an influencer: `influencerAccountId=<id>`, form-encoded, the same body
	// as `…/support`. The field is UNSET on the account (dropped from the JSON, not written
	// as 0), so `…/myinfluencer` goes back to 0. The id has to be an integer (else 400), but
	// it only has to NAME THE CURRENT PICK to do anything: naming anyone else — a stale pick
	// from before a `…/support` that replaced it, or nobody at all — is a no-op that still
	// answers success, like a wishlist remove of something not listed. Guarding on the match
	// keeps a stale client from clearing a pick it never saw.
	.post(
		'/api/influencerpartnerprogram/remove',
		describeRoute({
			tags: ['Econ'],
			summary: 'Stop supporting an influencer',
			description: [
				'Clear the influencer the caller supports in the partner program. `influencerAccountId`',
				'names the current pick; the field is unset and `…/myinfluencer` answers 0 again.',
				'An id that is not the current pick changes nothing and still answers success. The',
				'reply is the same `{ Success, Error, error_id }` status envelope as `…/support`.',
			].join(' '),
			security: AUTHED,
			requestBody: form(RemoveInfluencerBody, 'The influencer to stop supporting'),
			responses: {
				200: json(SupportInfluencerResponse, 'The pick was cleared (or was not this one)'),
				400: { description: '`influencerAccountId` missing or not an integer (empty body)' },
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)
			const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
			const raw = body.influencerAccountId
			const influencerId = Number.parseInt(typeof raw === 'string' ? raw : '', 10)
			if (!Number.isInteger(influencerId)) return c.body(null, 400)
			if ((await supportedInfluencer(c.env.DB, id)) === influencerId) {
				// `undefined` wins the spread in updateAccount and JSON.stringify drops the key.
				await updateAccount(c.env.DB, id, { supportedInfluencerId: undefined })
			}
			return c.json({ Success: true, Error: null, error_id: null })
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
					title: 'recflare econ',
					version: '1.0.0',
					description: [
						'Avatar and economy endpoints for recflare, a private-server reimplementation of the',
						'Rec Room backend. The client calls these on the `econ` host; many are also served by',
						'the `api` worker. Storefront catalogs are static assets (`sf{N}.json`); balances,',
						'inventory, consumables, saved outfits and gift boxes are D1-backed.',
					].join('\n'),
				},
				servers: [{ url: 'https://econ.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

// ---- Pont boutique du site (recblue.net) ----------------------------------
// Un achat PayPal confirmé sur le site crédite le compte de JEU et lui laisse une box
// du même montant. Appelé serveur-à-serveur par le Worker du site, jamais par le
// navigateur, et authentifié par le jeton partagé SITE_BRIDGE_TOKEN (vide = pont fermé).
/**
 * Retrouve un compte de JEU à partir du nom tapé dans l'administration du site : le pseudo
 * de connexion d'abord, puis le NOM AFFICHÉ. Un joueur qui s'est renommé en jeu garde son
 * pseudo de connexion, alors que le site ne connaît souvent que le nom affiché — sans ce
 * repli, un don de crédits échoue avec « aucun compte de jeu ».
 */
async function resolveGameAccount(db: D1Database, name: string) {
	const lowered = name.trim().toLowerCase()
	if (lowered === '') return null
	const { getAccount, getAccountByUsername } = await import('@repo/domain/src/accounts-db')
	const exact = await getAccountByUsername(db, lowered)
	if (exact !== null) return exact
	const row = await db
		.prepare(
			`SELECT account_id AS accountId FROM account
			  WHERE lower(json_extract(data, '$.displayName')) = ?1
			  ORDER BY account_id DESC LIMIT 1`
		)
		.bind(lowered)
		.first<{ accountId: number }>()
	if (!row) return null
	return getAccount(db, row.accountId)
}

app.post('/api/site/grant', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		tokens?: number
		message?: string
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	const tokens = Number(body?.tokens ?? 0)
	if (username === '' || !Number.isSafeInteger(tokens) || tokens <= 0) {
		return c.json({ error: 'bad request' }, 400)
	}

	const owner = await resolveGameAccount(c.env.DB, username)
	if (owner === null) return c.json({ error: 'no such account' }, 404)
	const resolvedUsername = String(owner.username || username)

	const { grantSiteCreditsByUsername } = await import('./site-gift')
	const result = await grantSiteCreditsByUsername(
		c.env,
		resolvedUsername,
		tokens,
		intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS),
		body?.message ? String(body.message) : undefined
	)
	if (result === null) return c.json({ error: 'no such account' }, 404)
	return c.json({ ok: true, ...result })
})

/**
 * Message général « Coach » : le site d'administration envoie un texte à tous les
 * joueurs CONNECTÉS. Même jeton de pont que les crédits ; rien n'est stocké, c'est une
 * annonce en direct (le hub notify ne la rejoue pas aux joueurs hors ligne).
 */
app.post('/api/site/coach-message', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as { messageContent?: string } | null
	const content = typeof body?.messageContent === 'string' ? body.messageContent.trim() : ''
	if (content === '' || content.length > 500) return c.json({ error: 'bad request' }, 400)

	const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
	const result = await hub.coachMessageAll(content)
	return c.json({ ok: true, sent: result.sent })
})

// Retrait de crédits : l'administration CORRIGE un solde (erreur de saisie, triche,
// remboursement). Même jeton de pont que le grant, aucune box envoyée, et le solde ne
// descend jamais sous 0.
app.post('/api/site/debit', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		tokens?: number
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	const tokens = Number(body?.tokens ?? 0)
	if (username === '' || !Number.isSafeInteger(tokens) || tokens <= 0) {
		return c.json({ error: 'bad request' }, 400)
	}

	const owner = await resolveGameAccount(c.env.DB, username)
	if (owner === null) return c.json({ error: 'no such account' }, 404)
	const resolvedUsername = String(owner.username || username)

	const { debitSiteCreditsByUsername } = await import('./site-gift')
	const result = await debitSiteCreditsByUsername(
		c.env,
		resolvedUsername,
		tokens,
		intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	)
	if (result === null) return c.json({ error: 'no such account' }, 404)
	return c.json({ ok: true, ...result })
})

// La liste des COMPTES DU JEU pour l'administration du site : qui existe, qui est en
// ligne, et quels droits chacun porte. Une seule requête, lue directement sur les comptes
// et les présences — le site n'en garde aucune copie.
app.get('/api/site/players', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const { results } = await c.env.DB.prepare(
		`SELECT a.account_id AS id,
		        json_extract(a.data, '$.username') AS username,
		        json_extract(a.data, '$.displayName') AS displayName,
		        json_extract(a.data, '$.profileImage') AS profileImage,
		        (json_extract(a.data, '$.isModerator') = 1) AS isModerator,
		        (json_extract(a.data, '$.isDeveloper') = 1) AS isDeveloper,
		        (coalesce(json_extract(a.data, '$.isInfluencer'), json_extract(a.data, '$.isCertified')) = 1) AS certified,
		        (json_extract(a.data, '$.banned') = 1) AS banned,
		        (json_extract(a.data, '$.hasPlus') = 1) AS plus,
		        json_extract(a.data, '$.createdAt') AS createdAt,
		        COALESCE(p.level, 1) AS level,
		        COALESCE(p.xp, 0) AS xp,
		        COALESCE(r.cheer_general, 0) + COALESCE(r.cheer_helpful, 0) +
		        COALESCE(r.cheer_creative, 0) + COALESCE(r.cheer_great_host, 0) +
		        COALESCE(r.cheer_sportsman, 0) AS likes
		   FROM account a
		   LEFT JOIN progression p ON p.account_id = a.account_id
		   LEFT JOIN reputation r ON r.account_id = a.account_id
		  WHERE a.account_id > 1
		  ORDER BY a.account_id DESC
		  LIMIT 2000`
	).all<{
		id: number
		username: string | null
		displayName: string | null
		profileImage: string | null
		isModerator: number
		isDeveloper: number
		certified: number
		banned: number
		plus: number
		createdAt: string | null
		level: number
		xp: number
		likes: number
	}>()

	const { results: present } = await c.env.DB.prepare(
		'SELECT DISTINCT account_id AS id FROM presence'
	).all<{ id: number }>()
	const online = new Set(present.map((row) => Number(row.id)))

	return c.json({
		players: results.map((row) => ({
			accountId: row.id,
			username: row.username ?? `Player${row.id}`,
			displayName: row.displayName ?? '',
			profileImage: row.profileImage ?? '',
			role: row.isDeveloper === 1 ? 'admin' : row.isModerator === 1 ? 'moderator' : 'member',
			isDeveloper: row.isDeveloper === 1,
			certified: row.certified === 1,
			banned: row.banned === 1,
			plus: row.plus === 1,
			online: online.has(row.id),
			createdAt: row.createdAt,
			level: row.level,
			xp: row.xp,
			likes: row.likes
		}))
	})
})

// Un like du site est un cheer GÉNÉRAL reçu par le joueur : il apparaît donc dans son
// profil de jeu (reputation.cheer_general), au lieu d'un compteur séparé que le jeu ne
// verrait jamais. Un même compte du site ne peut aimer le même joueur qu'une fois.
const SITE_LIKER = /^[a-zA-Z0-9_-]{8,80}$/

/** Le nombre de likes/cheers reçus par un compte, toutes catégories du jeu confondues. */
async function sitePlayerLikes(db: D1Database, accountId: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COALESCE(cheer_general, 0) + COALESCE(cheer_helpful, 0) +
			        COALESCE(cheer_creative, 0) + COALESCE(cheer_great_host, 0) +
			        COALESCE(cheer_sportsman, 0) AS likes
			   FROM reputation WHERE account_id = ?1`
		)
		.bind(accountId)
		.first<{ likes: number }>()
	return Number(row?.likes ?? 0)
}

// État d'un like pour le profil affiché. Appelé par le Worker du site avec le jeton du
// pont ; `liker` est l'identifiant du compte Supabase, jamais fourni par le navigateur.
app.get('/api/site/player-like', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const liker = String(c.req.query('liker') ?? '').trim()
	const target = String(c.req.query('target') ?? '').trim()
	if (!SITE_LIKER.test(liker) || target === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, target)
	if (account === null || account.accountId <= 1) return c.json({ error: 'no such account' }, 404)

	const row = await c.env.DB.prepare(
		'SELECT 1 AS ok FROM site_player_like WHERE liker = ?1 AND target_account_id = ?2'
	)
		.bind(liker, account.accountId)
		.first<{ ok: number }>()
	return c.json({ liked: row !== null, likes: await sitePlayerLikes(c.env.DB, account.accountId) })
})

// Enregistre le like et l'ajoute à la réputation du joueur. Le couple
// (compte du site, compte de jeu) est unique : un double clic ne recompte pas.
app.post('/api/site/player-like', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		liker?: unknown
		target?: unknown
	} | null
	const liker = String(body?.liker ?? '').trim()
	const target = String(body?.target ?? '').trim()
	if (!SITE_LIKER.test(liker) || target === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, target)
	if (account === null || account.accountId <= 1) return c.json({ error: 'no such account' }, 404)
	if ((account as unknown as { banned?: boolean }).banned === true) {
		return c.json({ error: 'banned' }, 403)
	}

	const inserted = await c.env.DB.prepare(
		`INSERT OR IGNORE INTO site_player_like (liker, target_account_id, created_at)
		 VALUES (?1, ?2, ?3)
		 RETURNING target_account_id`
	)
		.bind(liker, account.accountId, new Date().toISOString())
		.first<{ target_account_id: number }>()

	if (inserted !== null) {
		await c.env.DB.prepare(
			`INSERT INTO reputation (account_id, cheer_general) VALUES (?1, 1)
			 ON CONFLICT (account_id) DO UPDATE SET cheer_general = reputation.cheer_general + 1`
		)
			.bind(account.accountId)
			.run()
	}

	return c.json({
		liked: true,
		newLike: inserted !== null,
		likes: await sitePlayerLikes(c.env.DB, account.accountId)
	})
})

// La PHOTO DE PROFIL du JEU d'un compte : le site montre la même image que le jeu au lieu
// d'une copie séparée. Une clé vide veut dire « pas de photo ».
app.get('/api/site/profile-image', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const username = String(c.req.query('username') ?? '').trim()
	if (username === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ profileImage: '', bannerImage: '' })
	return c.json({
		username: account.username,
		profileImage: String(account.profileImage ?? ''),
		bannerImage: String(account.bannerImage ?? ''),
	})
})

// Statistiques LIVE du panneau « Statut » du site : joueurs connectés, appareils,
// versions du jeu et salles publiques actives. Mêmes requêtes que le worker Discord
// `recflare/status`, en lecture seule sur presence + room.
app.get('/api/site/status', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const [online, platforms, versions, rooms] = await c.env.DB.batch<Record<string, unknown>>([
		c.env.DB.prepare('SELECT COUNT(*) AS c FROM presence'),
		c.env.DB.prepare(
			`SELECT json_extract(data, '$.platform') AS platform, COUNT(*) AS c
			   FROM presence
			  GROUP BY platform
			  ORDER BY c DESC`
		),
		c.env.DB.prepare(
			`SELECT substr(v, 1, instr(v || '.', '.') - 1) AS build, platform, COUNT(*) AS c
			   FROM (
			     SELECT COALESCE(json_extract(data, '$.appVersion'), '') AS v,
			            json_extract(data, '$.platform') AS platform
			       FROM presence
			   )
			  GROUP BY build, platform`
		),
		c.env.DB.prepare(
			`SELECT COUNT(*) AS c, room.name
			   FROM presence
			   LEFT JOIN room ON room.room_id = presence.room_id
			  WHERE NOT room.is_dorm
			    AND json_extract(room.data, '$.Accessibility') = 1
			    AND json_extract(room.data, '$.ExcludeFromLists') IS NOT true
			  GROUP BY presence.room_id
			  ORDER BY c DESC
			  LIMIT 8`
		),
	])

	return c.json({
		online: Number(online?.results[0]?.c ?? 0),
		platforms: (platforms?.results ?? []).map((row) => ({
			platform: row.platform === null || row.platform === undefined ? null : Number(row.platform),
			count: Number(row.c ?? 0),
		})),
		versions: (versions?.results ?? []).map((row) => ({
			build: String(row.build ?? ''),
			platform: row.platform === null || row.platform === undefined ? null : Number(row.platform),
			count: Number(row.c ?? 0),
		})),
		rooms: (rooms?.results ?? []).map((row) => ({
			name: String(row.name ?? ''),
			count: Number(row.c ?? 0),
		})),
	})
})

// Combien de joueurs sont CONNECTÉS au jeu : une ligne de présence vivante par session.
// Le site affiche ce nombre ; rien de privé n'en sort, seulement le total.
app.get('/api/site/online', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first<{ n: number }>()
	return c.json({ online: Number(row?.n ?? 0) })
})

// Les photos prises EN JEU (ShareCamera) que le site a le droit de montrer : publiques et
// prises dans une chambre, les plus récentes d'abord. Le site ne recopie aucun fichier :
// il pointe le CDN du jeu avec le nom d'image.
app.get('/api/site/photos', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const asked = Number.parseInt(c.req.query('take') ?? '', 10)
	const take = asked > 0 ? Math.min(asked, 40) : 12
	const { results } = await c.env.DB.prepare(
		`SELECT json_extract(data, '$.Id') AS id,
		        json_extract(data, '$.ImageName') AS image,
		        json_extract(data, '$.PlayerId') AS player,
		        json_extract(data, '$.RoomId') AS room,
		        json_extract(data, '$.CreatedAt') AS takenAt
		   FROM image
		  WHERE type = ?1 AND accessibility = 1 AND room_id > 0
		  ORDER BY created_at DESC
		  LIMIT ?2`
	)
		.bind(SavedImageType.ShareCamera, take)
		.all<{ id: number; image: string; player: number; room: number; takenAt: string | null }>()

	// Pseudos et noms de chambres en deux requêtes groupées, jamais une par photo.
	const players = [...new Set(results.map((r) => r.player).filter((v): v is number => v != null))]
	const rooms = [...new Set(results.map((r) => r.room).filter((v): v is number => v != null))]
	const usernames = new Map<number, string>()
	if (players.length > 0) {
		const { results: rows } = await c.env.DB.prepare(
			`SELECT account_id AS id, json_extract(data, '$.username') AS username
			   FROM account WHERE account_id IN (${players.map(() => '?').join(',')})`
		)
			.bind(...players)
			.all<{ id: number; username: string }>()
		for (const row of rows) usernames.set(row.id, row.username)
	}
	const roomNames = new Map<number, string>()
	if (rooms.length > 0) {
		const { results: rows } = await c.env.DB.prepare(
			`SELECT room_id AS id, json_extract(data, '$.Name') AS name
			   FROM room WHERE room_id IN (${rooms.map(() => '?').join(',')})`
		)
			.bind(...rooms)
			.all<{ id: number; name: string }>()
		for (const row of rows) roomNames.set(row.id, row.name)
	}

	return c.json({
		photos: results.map((row) => ({
			id: row.id,
			image: row.image,
			username: usernames.get(row.player) ?? `Player${row.player}`,
			room: roomNames.get(row.room) ?? null,
			takenAt: row.takenAt
		}))
	})
})

// Combien de joueurs sont DANS chaque chambre en ce moment — une ligne par chambre
// occupée, et rien pour une chambre vide. Le site s'en sert pour afficher l'activité
// réelle de chaque chambre, jamais un compteur inventé.
app.get('/api/site/room-online', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const players = await countPlayersByRoom(c.env.DB)
	return c.json({
		rooms: [...players].map(([id, count]) => ({ id, players: count }))
	})
})

// Les compteurs RÉELS des chambres : visites, cheers et favoris. Ce sont des colonnes
// tenues à jour par le jeu (une visite par entrée, un clic par cheer/favori) — le blob
// de la chambre les garde à 0, donc le site ne peut pas les lire là.
app.get('/api/site/room-stats', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const { results } = await c.env.DB.prepare(
		'SELECT room_id AS id, visits, cheers, favorites FROM room'
	).all<{ id: number; visits: number; cheers: number; favorites: number }>()

	return c.json({
		stats: results.map((row) => ({
			id: row.id,
			visits: row.visits ?? 0,
			cheers: row.cheers ?? 0,
			favorites: row.favorites ?? 0
		}))
	})
})

// ---- REC BLUE Plus et bannissements pilotés par le site ---------------------
// Le site vend Plus AVEC une date de fin et bannit des joueurs depuis son panneau
// d'administration ; les deux arrivent ici par le même jeton partagé, jamais du navigateur.
app.post('/api/site/plus', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		until?: string | null
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)
	const until = body?.until === null || body?.until === undefined ? null : String(body.until)
	if (until !== null && Number.isNaN(Date.parse(until))) return c.json({ error: 'bad date' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const { setPlus } = await import('./site-flags')
	await setPlus(c.env.DB, account.accountId, until)
	return c.json({ ok: true, accountId: account.accountId, hasPlus: until !== null, until })
})

app.post('/api/site/ban', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		ban?: boolean
		reason?: string
		until?: string | null
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const { setBan } = await import('./site-flags')
	if (body?.ban !== true) {
		await setBan(c.env.DB, account.accountId, null)
		return c.json({ ok: true, accountId: account.accountId, banned: false })
	}

	const until = body.until === null || body.until === undefined ? null : String(body.until)
	if (until !== null && Number.isNaN(Date.parse(until))) return c.json({ error: 'bad date' }, 400)
	const reason = String(body.reason ?? '').slice(0, 200)
	await setBan(c.env.DB, account.accountId, { reason, until })
	// Le banni ne peut plus PROLONGER sa session : ses jetons de rafraîchissement sont
	// supprimés, donc la session ouverte meurt au plus tard avec son jeton d'accès (24 h)
	// et ne peut pas être renouvelée. Best-effort : la table appartient au worker `auth`.
	await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE account_id = ?1')
		.bind(account.accountId)
		.run()
		.catch(() => undefined)

	// Le joueur DÉJÀ en session ne doit pas continuer à jouer : on le prévient et on le
	// ramène au dortoir, exactement comme `www` le fait pour un ban posé sur un signalement.
	// `match` refuse ensuite toute room sauf le dortoir, où il retrouve cet écran. Le ban est
	// déjà enregistré : un hub indisponible ne doit pas le faire échouer.
	try {
		const presence = await getPresence<{ roomInstanceId?: number }>(c.env.DB, account.accountId)
		if (presence) {
			// Lu avant le déplacement, pour que le cadre nomme la session quittée et non le
			// dortoir d'arrivée.
			const gameSessionId = presence.roomInstance?.roomInstanceId ?? 0
			await movePlayerToDorm(c.env.DB, account.accountId)
			const frame: ModerationKickPayload = {
				ReportCategory: KickReportCategory.Misc,
				Duration:
					until === null
						? 2_147_483_647
						: Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000)),
				GameSessionId: gameSessionId,
				IsHostKick: false,
				Message: reason === '' ? 'Rule violation' : reason,
				PlayerIdReporter: null,
				IsBan: true,
				IsVoiceModAutoban: false,
				IsWarning: false,
				VoteKickReason: '',
				TimeoutStartedAt: null,
			}
			await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
				[account.accountId],
				NotificationType.ModerationKick,
				{ ...frame }
			)
		}
	} catch (err) {
		logger.error('failed to tell a site-banned player they are banned', {
			accountId: account.accountId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	return c.json({ ok: true, accountId: account.accountId, banned: true, reason, until })
})

// Les rôles d'ÉQUIPE du site appliqués au compte de JEU : un modérateur du site est
// modérateur en jeu (outil de communication d'équipe), un administrateur est staff
// (`isDeveloper` + `isModerator`). `auth` recopie ces drapeaux dans le claim `role`
// du jeton, et c'est ce claim que le client lit pour l'étiquette et les outils.
app.post('/api/site/role', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		role?: string
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)
	const role = String(body?.role ?? '').trim()
	if (role !== 'member' && role !== 'moderator' && role !== 'admin') {
		return c.json({ error: 'bad role' }, 400)
	}

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const { setRoles } = await import('./site-flags')
	const flags = await setRoles(c.env.DB, account.accountId, role)
	// La session déjà ouverte garde l'ancien rôle jusqu'à son prochain jeton : on ne coupe
	// pas le joueur pour un changement de droits. Un nouveau login suffit à l'appliquer.
	return c.json({ ok: true, accountId: account.accountId, role, ...flags })
})

// La CERTIFICATION REC BLUE : un badge accordé par l'administration du site, qui est le
// rôle `influencer` du jeu. Rangé sur le compte de JEU (`isInfluencer`), il part dans le
// claim `role` du jeton au login suivant : le badge s'affiche donc aussi dans le jeu.
app.post('/api/site/certify', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		certified?: boolean
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)
	const certified = body?.certified !== false

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const { setCertified } = await import('./site-flags')
	await setCertified(c.env.DB, account.accountId, certified)
	return c.json({ ok: true, accountId: account.accountId, certified })
})

// Le rôle `developer` SEUL (le badge Créateur/Dev de la plaque de nom), accordé ou retiré
// sans toucher à la modération ni au rôle du site. `auth` recopie `isDeveloper` dans le
// claim `role` du jeton au login suivant : c'est ce que le client affiche.
app.post('/api/site/developer', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as {
		username?: string
		developer?: boolean
	} | null
	const username = String(body?.username ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)
	const developer = body?.developer !== false

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const { setDeveloper } = await import('./site-flags')
	await setDeveloper(c.env.DB, account.accountId, developer)
	return c.json({ ok: true, accountId: account.accountId, developer })
})

// Lecture du badge pour un compte de jeu (pont uniquement : le Worker du site répond
// lui-même au navigateur, qui n'a jamais le jeton partagé).
app.get('/api/site/certified', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const username = String(c.req.query('username') ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ certified: false })

	const { readAccountFlags } = await import('./site-flags')
	const flags = await readAccountFlags(c.env.DB, account.accountId)
	// Le Plus du compte de JEU voyage avec la certification : le site ne stocke pas la date
	// d'abonnement, donc sans ça un Plus posé ici restait invisible sur le site (crédits
	// bleus au lieu d'or, pas de pastille Plus).
	const plus = flags.plusUntil !== null && Date.parse(flags.plusUntil) > Date.now()
	return c.json({ certified: flags.certified, plus, plusUntil: flags.plusUntil })
})

// Solde de JEU d'un joueur, pour que le site affiche le MÊME nombre que le jeu.
// Même jeton partagé que le grant : réservé au Worker du site, jamais au navigateur.
app.get('/api/site/balance', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const username = String(c.req.query('username') ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const balance = await getBalance(
		c.env.DB,
		account.accountId,
		CurrencyType.RecCenterTokens,
		intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	)
	return c.json({ ok: true, accountId: account.accountId, balance })
})

// ---------------------------------------------------------------------------
// Boutique depuis le site (l'app iOS installable).
//
// Le site (worker `www`) agit POUR un joueur déjà identifié par son pseudo de jeu :
// aucun jeton de joueur ne circule, et c'est le jeton de pont qui autorise, comme
// `/api/site/balance` et `/api/site/grant`. Le prix n'est JAMAIS celui du navigateur : il
// est relu dans le catalogue, avec la seule remise du serveur — les 10 % de REC BLUE Plus —
// et l'achat passe par le même `spendCurrency` / `grantGiftDrop` que le jeu, pour que le
// solde, l'inventaire et la boîte de cadeau restent identiques d'un chemin à l'autre.
// ---------------------------------------------------------------------------

/** Le prix catalogue en crédits Rec Center, ou `null` si l'article ne s'achète pas ainsi. */
function tokenPrice(item: StoreItem): number | null {
	const listed = item.Prices.find((p) => p.CurrencyType === CurrencyType.RecCenterTokens)
	return listed === undefined ? null : listed.Price
}

/** Le catalogue d'une boutique, tel que l'app l'affiche : id, nom et prix de base. */
app.get('/api/site/storefront', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const storefrontType = Number(c.req.query('storefront') ?? '3')
	if (!Number.isInteger(storefrontType) || storefrontType <= 0) {
		return c.json({ error: 'bad request' }, 400)
	}

	// Même lecture que l'affichage et l'achat : prix de base appliqués, thème Halloween,
	// extras maison et abonnement compris — ce que le joueur voit est ce qui se vend.
	const storefront = await loadStorefront(c, storefrontType)
	if (storefront === null) return c.json({ error: 'no such storefront' }, 404)

	const items = storefront.StoreItems.flatMap((item) => {
		const price = tokenPrice(item)
		if (price === null) return []
		return [
			{
				id: item.PurchasableItemId,
				name: item.GiftDrop.FriendlyName ?? '',
				desc: item.GiftDrop.AvatarItemDesc ?? '',
				price,
				plusOnly: item.GiftDrop.SubscribersOnly === true,
				box: item.GiftDrop.IsQuery === true,
			},
		]
	})
	items.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

	return c.json({ ok: true, storefront: storefrontType, items })
})

/** Le solde et la garde-robe d'un joueur, pour l'onglet « Inventaire » de l'app. */
app.get('/api/site/inventory', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const username = String(c.req.query('username') ?? '').trim().toLowerCase()
	if (username === '') return c.json({ error: 'bad request' }, 400)

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	const [balance, owned] = await Promise.all([
		getBalance(c.env.DB, account.accountId, CurrencyType.RecCenterTokens, startingTokens),
		getInventory(c.env.DB, account.accountId),
	])

	const items = owned.map((item) => ({
		name: item.FriendlyName ?? '',
		desc: item.AvatarItemDesc ?? '',
		type: item.AvatarItemType,
		rarity: item.Rarity,
	}))
	items.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

	return c.json({ ok: true, accountId: account.accountId, balance, items })
})

/** Un achat depuis l'app : débit atomique puis remise de l'article, comme `buyItem`. */
app.post('/api/site/buy', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'bad request' }, 400)
	}
	const username = String(body.username ?? '').trim().toLowerCase()
	const storefrontType = Number(body.storefront)
	const purchasableItemId = Number(body.item)
	if (
		username === '' ||
		!Number.isInteger(storefrontType) ||
		!Number.isInteger(purchasableItemId)
	) {
		return c.json({ error: 'bad request' }, 400)
	}

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const item = await findStoreItem(c, storefrontType, purchasableItemId)
	if (item === null) return c.json({ error: 'no such item' }, 404)
	const listed = tokenPrice(item)
	if (listed === null) return c.json({ error: 'not sold in credits' }, 400)

	// L'abonnement est relu en base : le site l'accorde sans reconnexion du client.
	const { readAccountFlags } = await import('./site-flags')
	const flags = await readAccountFlags(c.env.DB, account.accountId)
	const subscriber = flags.plusUntil !== null && Date.parse(flags.plusUntil) > Date.now()
	if (item.GiftDrop.SubscribersOnly === true && !subscriber) {
		return c.json({ error: 'Rec Room Plus required' }, 403)
	}

	// Seule remise du serveur : REC BLUE Plus, 10 % sous le prix catalogue.
	const charge = subscriber ? subscriberFloor(listed) : listed
	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	const paid = await spendCurrency(
		c.env.DB,
		account.accountId,
		CurrencyType.RecCenterTokens,
		charge,
		startingTokens
	)
	if (!paid) return c.json({ error: 'Insufficient balance' }, 400)

	// La boîte que le joueur ouvrira dans le jeu, exactement comme `buyItem` la crée :
	// même message par défaut qu'un achat sans cadeau, pas une chaîne vide — c'est ce que le
	// panneau de la boîte affiche.
	let granted: GrantedGift | null = null
	try {
		granted = await grantGiftDrop(c, account.accountId, item.GiftDrop, DEFAULT_GIFT_MESSAGE, {
			fromPlayerId: COACH_ACCOUNT_ID,
			giftContext: null,
		})
		// L'item REC BLUE Plus n'est pas un objet : il pose l'abonnement, et les bundles
		// vendent leur contenu — exactement comme dans `buyItem`.
		if (purchasableItemId === REC_BLUE_PLUS_ITEM_ID) {
			await grantRecBluePlus(c, account.accountId)
		}
		const bundle = REC_BLUE_BUNDLES[purchasableItemId]
		if (bundle !== undefined) {
			await grantRecBlueBundle(c, account.accountId, bundle)
		}
	} catch (error) {
		// Rien ne doit être facturé sans article : on rend les crédits avant de relancer.
		logger.error('site buy: grant failed, credits refunded', {
			accountId: account.accountId,
			storefrontType,
			purchasableItemId,
			charge,
			error: String(error),
		})
		await creditCurrency(
			c.env.DB,
			account.accountId,
			CurrencyType.RecCenterTokens,
			charge,
			startingTokens
		).catch(() => null)
		return c.json({ error: 'grant failed' }, 500)
	}

	const balance = await getBalance(
		c.env.DB,
		account.accountId,
		CurrencyType.RecCenterTokens,
		startingTokens
	)

	// Le joueur n'a rien cliqué DANS le jeu : sans ces deux frames il ne verrait pas la boîte
	// s'ouvrir et son client garderait un solde périmé — c'est la différence qui faisait
	// « acheter sur le site ne donne pas la boîte ». Ce sont les frames que `buyItem` et les
	// dons du serveur poussent déjà : la boîte (que le client consomme ensuite par
	// `POST /api/avatar/v2/gifts/consume`) puis le solde RÉSULTANT du débit.
	if (granted !== null) {
		await pushGiftReceived(
			c,
			account.accountId,
			granted,
			DEFAULT_GIFT_MESSAGE,
			COACH_ACCOUNT_ID
		)
	}
	await pushBalancePurchase(
		c,
		account.accountId,
		CurrencyType.RecCenterTokens,
		-charge,
		balance
	)

	return c.json({
		ok: true,
		balance,
		charged: charge,
		item: { id: purchasableItemId, name: item.GiftDrop.FriendlyName ?? '' },
	})
})

// ---------------------------------------------------------------------------
// Cadeaux de l'administration : offrir un objet directement dans la boîte du joueur.
// Le seul renseignement saisi est le pseudo ; l'objet est choisi dans le catalogue de la
// vitrine et part par `grantGiftDrop`, donc la boîte est celle d'un achat — mêmes lignes
// d'inventaire, même frame poussée au client. Aucun crédit n'est débité : c'est un don.
// ---------------------------------------------------------------------------

/** Les vitrines où l'administration peut piocher, dans l'ordre du menu du site. */
const GIFT_STOREFRONTS = [3, 2, 1, 100, 101, 102, 103, 300, 400, 401, 402, 403, 404, 405, 406, 500, 600]

/**
 * `GET /api/site/catalog?storefront=3` : tout ce que la vitrine contient, prix ou non —
 * un cadeau n'a pas de prix, donc le filtre du catalogue de vente ne s'applique pas ici.
 */
app.get('/api/site/catalog', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const storefrontType = Number(c.req.query('storefront') ?? '3')
	if (!Number.isInteger(storefrontType) || !GIFT_STOREFRONTS.includes(storefrontType)) {
		return c.json({ error: 'bad request' }, 400)
	}

	const storefront = await loadStorefront(c, storefrontType)
	if (storefront === null) return c.json({ error: 'no such storefront' }, 404)

	const items = storefront.StoreItems.flatMap((item) => {
		const name = item.GiftDrop.FriendlyName ?? ''
		if (name === '') return []
		return [
			{
				id: item.PurchasableItemId,
				name,
				desc: item.GiftDrop.AvatarItemDesc ?? '',
				price: tokenPrice(item),
				plusOnly: item.GiftDrop.SubscribersOnly === true,
			},
		]
	})
	items.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

	return c.json({ ok: true, storefront: storefrontType, storefronts: GIFT_STOREFRONTS, items })
})

/** `POST /api/site/gift-item { username, storefront, item, message }` : un cadeau en boîte. */
app.post('/api/site/gift-item', async (c) => {
	const expected = String(c.env.SITE_BRIDGE_TOKEN ?? '')
	const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
	if (expected === '' || given !== expected) return c.json({ error: 'unauthorized' }, 401)

	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'bad request' }, 400)
	}
	const username = String(body.username ?? '').trim().toLowerCase()
	const storefrontType = Number(body.storefront)
	const purchasableItemId = Number(body.item)
	if (
		username === '' ||
		!Number.isInteger(storefrontType) ||
		!Number.isInteger(purchasableItemId)
	) {
		return c.json({ error: 'bad request' }, 400)
	}

	const account = await resolveGameAccount(c.env.DB, username)
	if (account === null) return c.json({ error: 'no such account' }, 404)

	const item = await findStoreItem(c, storefrontType, purchasableItemId)
	if (item === null) return c.json({ error: 'no such item' }, 404)

	// Le message de la boîte : celui de l'administration, sinon le défaut d'un achat.
	const message = String(body.message ?? '').trim().slice(0, 200) || DEFAULT_GIFT_MESSAGE
	// La quantité : seul un consommable s'empile, et ses exemplaires tiennent dans UNE boîte —
	// c'est la ligne groupée de la boutique (`copies`). Un objet qu'on ne possède qu'une fois
	// ne peut pas être donné deux fois, donc la quantité y retombe à 1.
	const wanted = Number(body.quantity ?? 1)
	if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > 99) {
		return c.json({ error: 'bad request' }, 400)
	}
	const stacks =
		typeof item.GiftDrop.ConsumableItemDesc === 'string' &&
		item.GiftDrop.ConsumableItemDesc !== ''
	const copies = stacks ? wanted : 1
	const granted = await grantGiftDrop(c, account.accountId, item.GiftDrop, message, {
		fromPlayerId: COACH_ACCOUNT_ID,
		giftContext: null,
		copies,
	})
	// Le joueur n'a rien cliqué dans le jeu : sans cette frame, la boîte n'apparaîtrait
	// qu'après un redémarrage du client.
	await pushGiftReceived(c, account.accountId, granted, message, COACH_ACCOUNT_ID)

	return c.json({
		ok: true,
		username,
		accountId: account.accountId,
		giftId: granted.id,
		quantity: copies,
		stacks,
		item: { id: purchasableItemId, name: item.GiftDrop.FriendlyName ?? '' },
	})
})

export { app }

// The cron (wrangler.jsonc `triggers`, which sets how often): box every Discord supporter
// the tokens their role is mapped to in DISCORD_ROLE_TOKENS. A no-op, logged once, until the
// operator maps a role — see discord-role-gift.ts. The signup grant is seeded before the credit,
// as every other faucet here does, so it reads the same knob.
export const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
	ctx.waitUntil(grantDiscordRoleGifts(env, intVar(env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)))
}

// A Worker only runs `scheduled` when it's on the default export, so econ takes the object
// form the runtime requires (as `www` does for its role sweep and `match` for presence).
/**
 * 2025's served general store, parsed once per isolate from the static assets.
 *
 * This is the same `sf3-2025.json` the store page is served from, so `purchasableitems`
 * can answer a listing the D1 catalog has not been reloaded with. `ASSETS` is rooted at
 * `static/storefronts`, hence the bare filename.
 */
let store2025: Promise<Map<number, StoreListing>> | null = null
function store2025Listings(
	assets: Fetcher,
	requestUrl: string
): Promise<Map<number, StoreListing>> {
	if (store2025 !== null) return store2025
	const pending = assets
		.fetch(new URL('/sf3-2025.json', requestUrl))
		.then(async (res) => {
			if (!res.ok) return new Map<number, StoreListing>()
			const store = (await res.json()) as StorefrontDump
			return new Map(store.StoreItems.map((item) => [item.PurchasableItemId, item]))
		})
		.catch(() => {
			// Do not cache a transient assets failure for the isolate's lifetime.
			store2025 = null
			return new Map<number, StoreListing>()
		})
	store2025 = pending
	return pending
}

interface WardrobeItem2025 extends Record<string, unknown> {
	AvatarItemDesc: string
}

/** Every unique avatar item in 2025's served store, in the client's wardrobe shape. */
function allAvatarItems2025(store: Map<number, StoreListing>): WardrobeItem2025[] {
	const byDesc = new Map<string, WardrobeItem2025>()
	for (const listing of store.values()) {
		const desc = listing.GiftDrop.AvatarItemDesc
		if (desc === '' || byDesc.has(desc)) continue
		byDesc.set(desc, {
			AvatarItemDesc: desc,
			AvatarItemType: listing.GiftDrop.AvatarItemType ?? 0,
			PlatformMask: -1,
			FriendlyName: listing.GiftDrop.FriendlyName,
			Tooltip: listing.GiftDrop.Tooltip ?? '',
			Rarity: listing.GiftDrop.Rarity,
			TagList: listing.GiftDrop.TagList,
			AvatarItemId: listing.GiftDrop.AvatarItemId,
			IsBaseAvatarItem: false,
		})
	}
	return [...byDesc.values()]
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>
