/**
 * La boutique Halloween : pendant 48 h les vitrines du serveur mettent en avant une sélection
 * d'articles d'Halloween, puis tout revient à la normale — sans redéploiement.
 *
 * RIEN N'EST RETIRÉ du catalogue, et c'est le point le plus important du module :
 *   - les 12 cases du tableau du Rec Center sont câblées sur les `PurchasableItemId` du
 *     catalogue 2 (`sf2.json`). Servir d'autres articles à leur place ne les « remplace » pas :
 *     le client ne trouve plus l'article de la case et le tableau affiche « Coming Soon » ;
 *   - remplacer le catalogue de la boutique générale fait 404 à l'achat de tout article
 *     ordinaire — y compris depuis une page ouverte avant l'évènement, que le client garde en
 *     mémoire et dont il renvoie le prix et l'id.
 * D'où les deux mécanismes, tous deux sans effet de bord sur l'achat :
 *   - tableau du Rec Center : on RÉHABILLE chaque case (même `PurchasableItemId`, nom,
 *     vignette et prix de l'article Halloween), donc la case reste résolvable et l'achat
 *     fonctionne sur l'id d'origine ;
 *   - boutique générale : la sélection remonte en tête de liste et porte `AvailableUntil`,
 *     le reste du magasin suit, intact et toujours achetable.
 *
 * Deux garde-fous, dans cet ordre :
 *   - la var `HALLOWEEN_SHOP` doit valoir `on` : l'évènement est une décision d'exploitation,
 *     pas un effet de bord du calendrier. Un worker sans la var (les tests, un `wrangler dev`
 *     par défaut) sert donc le catalogue normal, et le déployer sans le drapeau éteint la
 *     boutique ;
 *   - {@link HALLOWEEN_END_MS} est une échéance codée : même drapeau laissé à `on`, la
 *     sélection cesse d'être servie passé cette date. Un évènement « 2 jours » ne peut pas
 *     rester allumé par oubli, et il n'y a rien à redéployer pour l'éteindre.
 *
 * Les articles sont désignés par leur NOM et pas par leur id : les deux catalogues servis
 * (`sf3.json` pour le build 20230414, `sf3-2025.json` au-delà) numérotent leurs articles
 * différemment mais gardent les mêmes noms — c'est déjà la règle des bundles, voir
 * `REC_BLUE_BUNDLES` dans econ.app.ts. Un nom absent du fichier servi est simplement ignoré.
 *
 * Prix : le prix de base du catalogue, comme partout ailleurs depuis que les soldes sont
 * retirées ; la remise Rec Room Plus reste la seule remise, et c'est `priceCheck` qui la borne
 * à l'achat. `AvailableUntil` porte l'échéance, pour que le client sache que ces articles sont
 * limités dans le temps.
 */

/** La valeur de `HALLOWEEN_SHOP` qui allume la boutique. */
export const HALLOWEEN_SHOP_FLAG = 'on'

/** Fin de l'évènement : jeudi 12 novembre 2026, 12:00 UTC (48 h après la mise en ligne). */
export const HALLOWEEN_END_MS = Date.UTC(2026, 10, 12, 12, 0, 0)

/**
 * La même échéance, dans la forme que le client attend (`AvailableUntil`, `NextUpdate`).
 *
 * SANS millisecondes, et ce n'est pas cosmétique : le client 2023 reconstruit ses dates avec
 * `new DateTime(y, m, d)` et rejette la vitrine ENTIÈRE quand il n'y arrive pas — un
 * `2026-11-12T12:00:00.000Z` lui faisait lever « Year, Month, and Day parameters describe an
 * un-representable DateTime », ce qui vidait toutes les boutiques. Les captures du jeu écrivent
 * `2026-11-12T12:00:00Z` : même format, à la seconde.
 */
export const HALLOWEEN_END_ISO = new Date(HALLOWEEN_END_MS).toISOString().replace('.000Z', 'Z')

/** La sélection Halloween elle-même : 12 pièces, servies telles quelles au magasin général. */
const HALLOWEEN_ITEMS: string[] = [
	'Skeleton Mask',
	'Skeleton Hoodie',
	'Zombie Head',
	'Zombie Vest',
	'Zombie Hands',
	'Werewolf Head',
	'Werewolf Shirt',
	'Witch Dress (Grim)',
	'Witch Hat (Grim)',
	'Pumpkin Costume',
	'Frankenstein Head',
	'Bat Costume Wings',
]

/**
 * Les 12 cases du tableau, par ID de case — jamais par position.
 *
 * Les deux Maker Pen manquantes y ont une place, et prennent celles de `Zombie Hands` et
 * `Werewolf Shirt` : le tableau n'a que 12 cases, et ces deux-là doublonnent déjà `Zombie Vest`
 * et `Werewolf Head`. Elles viennent de `rec-blue-skins.json`, que `themedCatalog` ajoute aussi
 * au catalogue source du tableau — sans ça leurs noms ne se résoudraient pas.
 *
 * La position a été essayée, et c'est un piège : le client GARDE le tableau qu'il a reçu
 * jusqu'à `NextUpdate`. Décaler la liste (les deux Maker Pen ajoutés en tête) faisait donc
 * acheter autre chose que ce qui était affiché — le joueur voyait « Zombie Vest » dans sa
 * copie et recevait « Skeleton Hoodie », l'article que le serveur avait déjà posé sur cet
 * id. Une table par id ne bouge plus quand la sélection change, et l'ajout d'un article ne
 * décale plus rien.
 */
// Liste de paires et non objet : `Object.values` réordonne les clés numériques par ordre
// croissant, ce qui remettrait les Maker Pen au milieu du tableau.
const BOARD_SLOTS: Array<readonly [number, string]> = [
	[1760, 'SUPER PUMA Maker Pen'],
	[1296, 'Creator Expo 2025 Makerpen Skin'],
	[1518, 'Skeleton Mask'],
	[1825, 'Skeleton Hoodie'],
	[2533, 'Zombie Head'],
	[541, 'Zombie Vest'],
	[538, 'Werewolf Head'],
	[539, 'Witch Dress (Grim)'],
	[2074, 'Witch Hat (Grim)'],
	[2493, 'Pumpkin Costume'],
	[2841, 'Frankenstein Head'],
	[2594, 'Bat Costume Wings'],
]

const BOARD_SLOT_NAMES = new Map(BOARD_SLOTS)

const REC_CENTER_BOARD: string[] = BOARD_SLOTS.map(([, name]) => name)

/** Le magasin général : la sélection Halloween, plus 12 pièces de plus pour que la vitrine respire. */
const GENERAL_STORE: string[] = [
	...HALLOWEEN_ITEMS,
	'Mummy Head Wrap',
	'Mummy Shroud',
	'Mummy Hand Wrap',
	'Scarecrow Hat',
	'Scarecrow Overalls',
	'Scarecrow Wrists',
	'Witch Dress (Emerald)',
	'Witch Hat (Emerald)',
	'Witch Hunter Hat (Blue)',
	'Witch Hunter Gloves (Blue)',
	'Witch Hunter Torso (Blue)',
	'Bog Monster Suit',
]

/** Storefront id → les noms servis à sa place pendant l'évènement. */
export const HALLOWEEN_SELECTION: Record<number, string[]> = {
	2: REC_CENTER_BOARD,
	3: GENERAL_STORE,
}

/** L'id du tableau du Rec Center, le seul storefront à nombre de cases FIXE. */
const BOARD_STOREFRONT = 2

/** Le strict minimum qu'un article doit porter pour être reconnu et réécrit ici. */
export interface ThemedListing {
	PurchasableItemId?: number
	GiftDrop?: { FriendlyName?: string }
	Prices?: unknown
	SubscriberPrices?: unknown
	AvailableUntil?: string | null
}

/** L'évènement est-il en cours, drapeau ET échéance compris ? */
export function halloweenIsLive(flag: string | undefined, now = Date.now()): boolean {
	return flag === HALLOWEEN_SHOP_FLAG && now < HALLOWEEN_END_MS
}

/**
 * Le catalogue à servir pour ce storefront : la sélection Halloween quand l'évènement est en
 * cours, le catalogue inchangé sinon. Un storefront sans sélection n'est jamais touché.
 *
 * `source` est le catalogue où PUISER la sélection, quand ce n'est pas celui qu'on sert. Le
 * tableau du Rec Center (storefront 2) ne vend aucun article Halloween dans son propre
 * fichier : ses cases sont remplies avec la sélection du magasin général du même build,
 * sinon l'évènement le laisserait intact.
 */
export function halloweenCatalog<T extends { StoreItems?: ThemedListing[] | null }>(
	storefront: T,
	storefrontType: number,
	flag: string | undefined,
	now = Date.now(),
	source?: { StoreItems?: ThemedListing[] | null }
): T {
	const names = HALLOWEEN_SELECTION[storefrontType]
	if (names === undefined || !halloweenIsLive(flag, now)) return storefront
	const items = storefront.StoreItems ?? []
	const pool = source?.StoreItems ?? items
	// Le premier article qui porte le nom gagne : un catalogue peut lister deux fois le même
	// article (une pièce seule et son lot), et le tableau n'en veut qu'un.
	const byName = new Map<string, ThemedListing>()
	for (const item of pool) {
		const name = item.GiftDrop?.FriendlyName
		if (typeof name === 'string' && !byName.has(name)) byName.set(name, item)
	}
	const selection: ThemedListing[] = []
	for (const name of names) {
		const item = byName.get(name)
		if (item !== undefined) selection.push(item)
	}
	if (selection.length === 0) return storefront
	// Le tableau du Rec Center : une case garde SON id, et prend le nom, la vignette et le prix
	// de l'article Halloween. Remplacer l'article par un autre id viderait la case, et choisir
	// par position fait acheter l'article d'une autre case dès que la liste bouge — d'où la
	// table par id, `BOARD_SLOTS`.
	if (storefrontType === BOARD_STOREFRONT) {
		let relabelled = false
		const slots = items.map((slot) => {
			const id = slot.PurchasableItemId
			if (id === undefined) return slot
			const name = BOARD_SLOT_NAMES.get(id)
			if (name === undefined) return slot
			const pick = byName.get(name)
			if (pick === undefined) return slot
			relabelled = true
			return {
				...slot,
				GiftDrop: pick.GiftDrop,
				Prices: pick.Prices,
				SubscriberPrices: pick.SubscriberPrices,
				AvailableUntil: HALLOWEEN_END_ISO,
			}
		})
		// Aucune case reconnue : on ne touche pas au tableau plutôt que d'en servir un vide.
		if (!relabelled) return storefront
		// La vitrine change à la fin de l'évènement : c'est la seule date de renouvellement
		// honnête à servir tant qu'il dure (voir `NEXT_UPDATE_SENTINEL` sinon).
		return { ...storefront, NextUpdate: HALLOWEEN_END_ISO, StoreItems: slots } as T
	}
	// La boutique générale ne perd RIEN : la sélection remonte en tête et annonce son échéance,
	// le reste du magasin suit tel quel, toujours achetable.
	const selected = new Set(selection.map((item) => item.PurchasableItemId))
	const front = items
		.filter((item) => selected.has(item.PurchasableItemId))
		.map((item) => ({ ...item, AvailableUntil: HALLOWEEN_END_ISO }))
	const rest = items.filter((item) => !selected.has(item.PurchasableItemId))
	return { ...storefront, NextUpdate: HALLOWEEN_END_ISO, StoreItems: [...front, ...rest] } as T
}
