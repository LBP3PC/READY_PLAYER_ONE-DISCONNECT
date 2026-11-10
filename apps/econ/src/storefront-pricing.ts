import { CurrencyType } from './currency'

/**
 * Les boutiques servent les PRIX DE BASE : aucune solde, aucune remise de la semaine.
 *
 * Les captures `sf*.json` portent les soldes de l'époque (le dump 2025 a même été pris en
 * pleine braderie : 80 % sur presque tout, sans date de fin). Ce module les retire au moment
 * de servir, pour que le joueur voie — et paie — le prix catalogue partout. La seule remise
 * qui reste est celle de Rec Room Plus, appliquée par le client et bornée par `priceCheck`
 * dans econ.app.ts : 10 % sous le prix affiché, jamais plus.
 *
 * Ce que ce module décide, et ce qu'il ne décide PAS :
 *   - `StorefrontSaleData` est mis à `null` sur chaque prix en tokens, donc ni le tableau du
 *     Rec Center ni la fiche renvoyée par `purchasableitems` n'annoncent de solde ;
 *   - `NextUpdate` porte une sentinelle « qui n'arrive jamais » (voir
 *     {@link NEXT_UPDATE_SENTINEL}) : la vitrine est figée, donc elle n'annonce pas de
 *     renouvellement réel ;
 *   - les articles restent TOUS au catalogue et le prix catalogue n'est jamais touché : les
 *     cases du tableau sont câblées sur des `PurchasableItemId` fixes, donc un article retiré
 *     serait une case vide, et son achat un 404.
 *
 * Le prix catalogue est d'ailleurs le seul accepté à l'achat pour un joueur sans Plus (voir
 * `priceCheck`).
 */

/**
 * La date que porte une vitrine qui ne renouvelle rien : celle de la vraie Rec Room
 * (`2222-02-22T22:22:00Z`), telle qu'elle apparaît dans les captures du jeu.
 *
 * Ni `null` ni une date proche : le client reconstruit chaque date avec
 * `new DateTime(y, m, d)` et jette la vitrine ENTIÈRE quand il n'y arrive pas. `null` et une
 * chaîne ISO avec millisecondes (`…T12:00:00.000Z`) lui font lever « Year, Month, and Day
 * parameters describe an un-representable DateTime » — constaté en jeu : toutes les boutiques
 * s'affichaient vides. La sentinelle se lit, elle, sans erreur.
 */
export const NEXT_UPDATE_SENTINEL = '2222-02-22T22:22:00Z'

/** Le bloc `StorefrontSaleData` d'un prix de catalogue. */
export interface StorefrontSale {
	SalePercent: number
	SaleStartDate: string | null
	SaleEndDate: string | null
}

/** Un prix de catalogue, tel que les deux sources le portent (fichier `sf*.json` et table). */
interface PricedPrice {
	CurrencyType: number
	Price: number
	StorefrontSaleData?: StorefrontSale | null
}

/** Un article de boutique, tel que les deux sources le portent. Volontairement minimal :
 * tout le reste de l'entrée (GiftDrop, Type, badges) traverse le module sans être typé. */
export interface PricedListing {
	PurchasableItemId: number
	Prices?: PricedPrice[] | null
}

/**
 * Retire la solde d'une liste de prix. Seuls les prix en `RecCenterTokens` sont concernés :
 * les monnaies d'activité (tickets de laser tag, or des crânes perdus…) ont leurs propres
 * magasins et ne se vendent pas au tableau du Rec Center.
 */
function basePrices<T extends PricedPrice>(prices: T[] | null | undefined): T[] | null | undefined {
	if (!prices) return prices
	// Seul `StorefrontSaleData` est réécrit ; le reste de l'entrée vient du fichier, donc garde
	// la forme exacte que le build du joueur sait décoder.
	return prices.map((price) =>
		price.CurrencyType === CurrencyType.RecCenterTokens
			? ({ ...price, StorefrontSaleData: null } as T)
			: price
	)
}

/** Les articles d'un catalogue, au prix de base (sans solde). */
export function basePriceListings<T extends PricedListing>(items: T[]): T[] {
	return items.map((item) => ({ ...item, Prices: basePrices(item.Prices) }) as T)
}

/**
 * Un catalogue de boutique prêt à servir : prix de base, et aucune date de renouvellement.
 * Appliqué aux DEUX chemins (le fichier servi et les fiches par id), sinon le prix affiché et
 * le prix vérifié à l'achat divergeraient.
 *
 * `NextUpdate` porte {@link NEXT_UPDATE_SENTINEL} : la boutique est figée, elle ne renouvelle
 * plus sa vitrine. Les captures portaient des dates qui n'ont plus de sens (le tableau du Rec
 * Center annonçait 2032), et une date hebdomadaire serait fausse dans l'autre sens : elle
 * promettrait un changement de vitrine qui n'arrive jamais.
 */
export function basePriceStorefront<
	T extends { StoreItems?: PricedListing[] | null; NextUpdate?: string | null },
>(storefront: T): T {
	const items = storefront.StoreItems
	return {
		...storefront,
		NextUpdate: NEXT_UPDATE_SENTINEL,
		...(items ? { StoreItems: basePriceListings(items) } : {}),
	} as T
}
