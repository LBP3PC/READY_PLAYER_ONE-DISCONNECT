import { describe, expect, test } from 'vitest'

import {
	HALLOWEEN_END_ISO,
	HALLOWEEN_END_MS,
	HALLOWEEN_SELECTION,
	HALLOWEEN_SHOP_FLAG,
	halloweenCatalog,
	halloweenIsLive,
} from '../halloween-shop'

/** Un article de vitrine réduit à ce que la thématisation lit. */
const listing = (name: string, id: number, price = 1000) => ({
	PurchasableItemId: id,
	GiftDrop: { FriendlyName: name, ThumbnailImageName: name.slice(0, 4) },
	Prices: [{ CurrencyType: 2, Price: price, StorefrontSaleData: null }],
	SubscriberPrices: [{ CurrencyType: 2, Price: price - 100, StorefrontSaleData: null }],
	AvailableAt: null,
	AvailableUntil: null,
})

/** Un catalogue qui contient tous les noms de la sélection demandée. */
const catalogWith = (names: string[], price = 1000) => ({
	StorefrontType: 3,
	NextUpdate: null,
	StoreItems: names.map((name, index) => listing(name, 1000 + index, price)),
})

describe('boutique Halloween', () => {
	const live = Date.UTC(2026, 10, 10, 12, 0, 0)

	test("la date de fin est dans le format que le client sait lire", () => {
		// Pas de millisecondes : `new DateTime(y, m, d)` côté client lève une exception sur un
		// `…T12:00:00.000Z`, et la vitrine entière est alors rejetée (boutiques vides).
		expect(HALLOWEEN_END_ISO).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
	})

	test('le tableau du Rec Center met les deux Maker Pen en tête de ses 12 cases', () => {
		expect(HALLOWEEN_SELECTION[2]).toHaveLength(12)
		expect(HALLOWEEN_SELECTION[2].slice(0, 2)).toEqual([
			'SUPER PUMA Maker Pen',
			'Creator Expo 2025 Makerpen Skin',
		])
	})

	test('le drapeau allume la boutique, son absence la laisse éteinte', () => {
		expect(halloweenIsLive(HALLOWEEN_SHOP_FLAG, live)).toBe(true)
		expect(halloweenIsLive(undefined, live)).toBe(false)
		expect(halloweenIsLive('off', live)).toBe(false)
	})

	test("l'échéance éteint la boutique même drapeau laissé à on", () => {
		expect(halloweenIsLive(HALLOWEEN_SHOP_FLAG, HALLOWEEN_END_MS - 1)).toBe(true)
		// Une seconde trop tard : plus rien, et sans redéploiement.
		expect(halloweenIsLive(HALLOWEEN_SHOP_FLAG, HALLOWEEN_END_MS)).toBe(false)
	})

	test('éteinte, elle rend le catalogue tel quel', () => {
		const catalog = catalogWith(HALLOWEEN_SELECTION[3])
		expect(halloweenCatalog(catalog, 3, undefined, live)).toBe(catalog)
		expect(halloweenCatalog(catalog, 3, HALLOWEEN_SHOP_FLAG, HALLOWEEN_END_MS)).toBe(catalog)
	})

	test('un storefront sans sélection n’est jamais touché', () => {
		const catalog = catalogWith(['Un chapeau', 'Une veste'])
		expect(halloweenCatalog(catalog, 1, HALLOWEEN_SHOP_FLAG, live)).toBe(catalog)
	})

	test('la boutique générale ne retire RIEN : la sélection remonte en tête', () => {
		const horsSelection = ['Un article ordinaire', 'Un autre article']
		const catalog = catalogWith([...horsSelection, ...HALLOWEEN_SELECTION[3]])
		const served = halloweenCatalog(catalog, 3, HALLOWEEN_SHOP_FLAG, live)
		// Pendant l'évènement, la vitrine change vraiment à la fin : c'est la seule date de
		// renouvellement honnête, et elle est lisible par le client.
		expect(served.NextUpdate).toBe(HALLOWEEN_END_ISO)
		// Le catalogue entier est toujours là, dans le même nombre : aucun achat ne peut 404.
		expect(served.StoreItems).toHaveLength(catalog.StoreItems.length)
		expect(served.StoreItems.map((item) => item.GiftDrop?.FriendlyName)).toEqual([
			...HALLOWEEN_SELECTION[3],
			...horsSelection,
		])
		// La sélection annonce sa date de fin, le reste du magasin n'en porte pas.
		const selection = served.StoreItems.slice(0, HALLOWEEN_SELECTION[3].length)
		expect(selection.every((item) => item.AvailableUntil === HALLOWEEN_END_ISO)).toBe(true)
		expect(served.StoreItems.at(-1)?.AvailableUntil).toBeNull()
		// Et les prix ne bougent pas : prix de base du catalogue.
		expect(served.StoreItems.every((item) => item.Prices?.[0]?.Price === 1000)).toBe(true)
	})

	test('le tableau du Rec Center garde ses ids et prend les articles Halloween', () => {
		// Les cases du tableau sont câblées sur des ids : les remplacer les viderait. On
		// réhabille donc chaque case — même id, article Halloween.
		const board = {
			StoreItems: [listing('Retro Sunglasses', 1760, 2000), listing('Banker Vest', 2533, 3000)],
		}
		const source = catalogWith(HALLOWEEN_SELECTION[2], 800)
		const served = halloweenCatalog(board, 2, HALLOWEEN_SHOP_FLAG, live, source)
		expect(served.StoreItems.map((item) => item.PurchasableItemId)).toEqual([1760, 2533])
		// La correspondance est par ID de case, pas par position : 1760 est la case du Maker Pen
		// SUPER PUMA, 2533 celle du Zombie Head.
		expect(served.StoreItems.map((item) => item.GiftDrop?.FriendlyName)).toEqual([
			'SUPER PUMA Maker Pen',
			'Zombie Head',
		])
		// Le prix affiché est celui de l'article Halloween, donc celui qui sera facturé.
		expect(served.StoreItems.every((item) => item.Prices?.[0]?.Price === 800)).toBe(true)
		expect(served.StoreItems.every((item) => item.AvailableUntil === HALLOWEEN_END_ISO)).toBe(
			true
		)
	})

	test('changer l’ordre de la sélection ne change pas l’article d’une case', () => {
		// Le client garde le tableau qu'il a reçu jusqu'à `NextUpdate` : si la sélection était
		// appliquée par position, ajouter un article en tête ferait acheter, sur une case encore
		// affichée « Zombie Vest », l'article que le serveur y a déplacé (« Skeleton Hoodie »).
		const board = {
			StoreItems: [listing('Première case', 541, 3000), listing('Deuxième case', 1825, 3000)],
		}
		const ordreInitial = catalogWith(HALLOWEEN_SELECTION[2], 3000)
		const ordreInverse = {
			StoreItems: [...ordreInitial.StoreItems].reverse(),
		}

		const avant = halloweenCatalog(board, 2, HALLOWEEN_SHOP_FLAG, live, ordreInitial)
		const apres = halloweenCatalog(board, 2, HALLOWEEN_SHOP_FLAG, live, ordreInverse)

		expect(avant.StoreItems.map((item) => item.GiftDrop?.FriendlyName)).toEqual([
			'Zombie Vest',
			'Skeleton Hoodie',
		])
		expect(apres.StoreItems.map((item) => item.GiftDrop?.FriendlyName)).toEqual(
			avant.StoreItems.map((item) => item.GiftDrop?.FriendlyName)
		)
	})

	test('le tableau sans source reste intact : son catalogue n’a aucun article Halloween', () => {
		const board = { StoreItems: [listing('Retro Sunglasses', 1760, 2000)] }
		expect(halloweenCatalog(board, 2, HALLOWEEN_SHOP_FLAG, live)).toBe(board)
	})

	test('un nom listé deux fois ne prend que le premier article', () => {
		const boardNames = HALLOWEEN_SELECTION[2]
		const source = {
			StoreItems: [
				listing(boardNames[0], 1, 111),
				listing(boardNames[0], 2, 222),
				...boardNames.slice(1).map((name, index) => listing(name, 100 + index)),
			],
		}
		const board = { StoreItems: [listing('Case du tableau', 1760, 2000)] }
		const served = halloweenCatalog(board, 2, HALLOWEEN_SHOP_FLAG, live, source)
		expect(served.StoreItems[0].GiftDrop?.FriendlyName).toBe(boardNames[0])
		expect(served.StoreItems[0].Prices?.[0]?.Price).toBe(111)
	})
})
