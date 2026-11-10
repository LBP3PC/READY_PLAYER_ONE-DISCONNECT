/**
 * Owned avatar items on the shared `recflare` D1 database — the items a player has
 * bought from a storefront. One row per (account, item): the item is granted at
 * purchase time (`POST /api/storefronts/v2/buyItem`) and read back by
 * `GET /api/avatar/v4/items`, which concatenates it with the default catalog.
 *
 * The item is keyed by its full `AvatarItemDesc` — the comma-delimited descriptor exactly
 * as sent, trailing `,,,` and all — so re-buying the same item upserts rather than piling
 * up duplicate rows. The descriptor is stored verbatim (not normalized): the client expects
 * the commas back and fails without them. `data` is the rendered avatar-item DTO, stored
 * opaquely and served back untouched; it matches the shape of the entries in
 * default-avatar-items.json.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0004_inventory.sql. The gift box the purchase also creates lives in a separate table
 * (@repo/domain's received_gift); ownership does not depend on the box being opened.
 */

/** Schema DDL (mirror of migrations 0004_inventory.sql) — also builds the table in tests. */
export const INVENTORY_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS inventory (
		account_id INTEGER NOT NULL,
		avatar_item_desc TEXT NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY (account_id, avatar_item_desc)
	)`,
]

/**
 * A rendered avatar item, as `/api/avatar/v4/items` serves it (same shape as the
 * entries in default-avatar-items.json). `AvatarItemDesc` is the item's guid string
 * and the row's key.
 */
export interface AvatarItem extends Record<string, unknown> {
	AvatarItemType: number | null
	AvatarItemDesc: string
	PlatformMask: number
	FriendlyName: string
	Tooltip: string
	Rarity: number
}

/**
 * The camelCase DTO `GET /api/avatar/v4/items` serves. Distinct from the PascalCase
 * `AvatarItem` we store and from what the sibling item endpoints (`defaultunlocked`,
 * `defaultbaseavataritems`) serve — those hand back their stored/bundled records raw.
 */
export interface AvatarItemV4 {
	avatarItemId: number
	avatarItemDesc: string
	friendlyName: string
	tooltip: string
	tagList: string
	avatarItemType: number
	rarity: number
	isBaseAvatarItem: boolean
}

/**
 * Project a stored or bundled avatar item into the v4 DTO. The storefront gift-drops
 * we grant from carry no `AvatarItemId`, `TagList` or `IsBaseAvatarItem` flag, and the
 * default catalog's `TagList` is null, so missing values default to 0 / "" / false rather
 * than being invented.
 */
export function toAvatarItemV4(item: Record<string, unknown>): AvatarItemV4 {
	const str = (v: unknown): string => (typeof v === 'string' ? v : '')
	const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
	return {
		avatarItemId: num(item.AvatarItemId),
		avatarItemDesc: str(item.AvatarItemDesc),
		friendlyName: str(item.FriendlyName),
		tooltip: str(item.Tooltip),
		tagList: str(item.TagList),
		avatarItemType: num(item.AvatarItemType),
		rarity: num(item.Rarity),
		isBaseAvatarItem: item.IsBaseAvatarItem === true,
	}
}

/** Give each distinct legacy wardrobe item a non-zero id without changing its descriptor. */
export function legacyWardrobeItems(items: AvatarItemV4[]): AvatarItemV4[] {
	const unique = new Map<string, AvatarItemV4>()
	for (const item of items) {
		const key = `${item.avatarItemType}:${item.avatarItemDesc}`
		const previous = unique.get(key)
		if (!previous || (previous.avatarItemId <= 0 && item.avatarItemId > 0)) unique.set(key, item)
	}

	const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const ids = new Map<string, number>()
	const used = new Set<number>()
	// Retain the catalog's real ids wherever possible; resolve collisions deterministically.
	for (const [key, item] of ordered) {
		const id = item.avatarItemId
		if (Number.isInteger(id) && id > 0 && id <= 0x7fffffff && !used.has(id)) {
			ids.set(key, id)
			used.add(id)
		}
	}
	for (const [key] of ordered) {
		if (ids.has(key)) continue
		let hash = 2166136261
		for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
		let id = (hash >>> 0) & 0x7fffffff
		if (id === 0) id = 1
		while (used.has(id)) id = id === 0x7fffffff ? 1 : id + 1
		ids.set(key, id)
		used.add(id)
	}
	return [...unique.entries()].map(([key, item]) => ({ ...item, avatarItemId: ids.get(key)! }))
}

/**
 * Grant an item into a player's inventory. Upserts on (account_id, avatar_item_desc):
 * owning an item is boolean, so re-buying it refreshes the stored DTO rather than
 * adding a second copy. The descriptor is stored verbatim, commas included — the client
 * expects the full comma-delimited form back.
 */
export async function grantItem(
	db: D1Database,
	accountId: number,
	item: AvatarItem
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO inventory (account_id, avatar_item_desc, data) VALUES (?1, ?2, ?3)
			 ON CONFLICT (account_id, avatar_item_desc) DO UPDATE SET data = ?3`
		)
		.bind(accountId, item.AvatarItemDesc, JSON.stringify(item))
		.run()
}

/** Every avatar item a player owns, ordered by item guid for a stable listing. */
export async function getInventory(db: D1Database, accountId: number): Promise<AvatarItem[]> {
	const { results } = await db
		.prepare('SELECT data FROM inventory WHERE account_id = ?1 ORDER BY avatar_item_desc')
		.bind(accountId)
		.all<{ data: string }>()
	return results.map((r) => JSON.parse(r.data) as AvatarItem)
}
