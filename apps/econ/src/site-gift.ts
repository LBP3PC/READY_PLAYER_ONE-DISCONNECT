/**
 * Le pont « boutique du site » : créditer un compte de jeu et lui laisser une box.
 *
 * Quand un joueur achète des crédits sur recblue.net, le Worker du site appelle
 * `POST /api/site/grant` sur econ (voir econ.app.ts), authentifié par le jeton partagé
 * `SITE_BRIDGE_TOKEN`. Ce module fait les trois mêmes gestes que les autres robinets
 * serveur d'econ (le cadeau Discord, les récompenses de jeu) :
 *
 *  1. semer le grant d'inscription,
 *  2. créditer le solde RecCenterTokens,
 *  3. créer une box qui affiche le montant, annoncée par `StorefrontBalanceUpdate`
 *     (le total RÉSULTANT) puis `GiftPackageReceivedImmediate`, dans cet ordre pour que
 *     la box arrive sur un solde qui l'inclut déjà. Un joueur hors ligne la retrouve à
 *     sa prochaine lecture de `GET /api/avatar/v2/gifts`.
 *
 * La box est ouverte par le compte système « Coach » (1), comme les autres boxes
 * offertes par le serveur.
 */

import { createGift } from '@repo/domain'
import { getAccountByUsername } from '@repo/domain/src/accounts-db'

import { NotificationType } from '../../notify/src/notification-types'
import { ALL_PLATFORMS, CurrencyType, creditCurrency, ensureStartingBalances } from './balance-db'

import type { GiftContent } from '@repo/domain'
import type {
	BalanceResponsePayload,
	GiftPackagePayload,
} from '../../notify/src/notification-payloads'
import type { PlayerNotification } from '../../notify/src/notifications-hub'
import type { Env } from './context'

/** Le compte système « Coach » — l'expéditeur d'une box offerte par le serveur. */
const COACH_ACCOUNT_ID = 1

/** L'instance du hub notify que tous les workers adressent (voir econ.app.ts). */
const HUB_INSTANCE = 'global'

/** Le message par défaut affiché sur la box. */
export const SITE_PURCHASE_MESSAGE = 'Merci pour ton achat sur recblue.net !'

/**
 * Ce dont un grant a besoin sur les bindings : la base et le hub. Nommé en `Pick` pour
 * qu'un autre worker puisse passer ses propres bindings sans prétendre être econ.
 */
export type SiteGiftEnv = Pick<Env, 'DB' | 'RECFLARE_NOTIFICATIONS_HUB'>

/** La box stockée : des jetons du Coach, rien d'autre. */
function siteGiftContent(tokens: number, message: string): GiftContent {
	return {
		FromPlayerId: COACH_ACCOUNT_ID,
		// `Default` (0) : une box de jetons se dessine telle quelle sous ce contexte.
		GiftContext: 0,
		ConsumableItemDesc: '',
		ConsumableCount: 0,
		AvatarItemDesc: '',
		// NULL, jamais 0 : le client route sur ce champ avant de lire le reste.
		AvatarItemType: null,
		CurrencyType: CurrencyType.RecCenterTokens,
		Currency: tokens,
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
 * Les deux frames qui annoncent une box stockée, dans l'ordre : le solde d'abord — le
 * total RÉSULTANT, dans le bucket -2 ; la frame le POSE — pour que l'annonce de la box
 * tombe sur un total qui l'inclut déjà.
 */
function giftFrames(
	accountId: number,
	balance: number,
	giftId: number,
	content: GiftContent
): PlayerNotification[] {
	return [
		{
			playerId: accountId,
			notificationType: NotificationType.StorefrontBalanceUpdate,
			data: {
				Balance: balance,
				CurrencyType: CurrencyType.RecCenterTokens,
				Platform: ALL_PLATFORMS,
			} satisfies BalanceResponsePayload,
		},
		{
			playerId: accountId,
			notificationType: NotificationType.GiftPackageReceivedImmediate,
			data: {
				Id: giftId,
				FromPlayerId: COACH_ACCOUNT_ID,
				ConsumableItemDesc: content.ConsumableItemDesc,
				AvatarItemType: content.AvatarItemType,
				AvatarItemDesc: content.AvatarItemDesc,
				EquipmentPrefabName: content.EquipmentPrefabName,
				EquipmentModificationGuid: content.EquipmentModificationGuid,
				CurrencyType: content.CurrencyType,
				Currency: content.Currency,
				Xp: content.Xp,
				GiftContext: content.GiftContext ?? 0,
				GiftRarity: content.GiftRarity,
				Message: content.Message,
				Platform: -1,
				PlatformsToSpawnOn: -1,
				BalanceType: ALL_PLATFORMS,
			} satisfies GiftPackagePayload,
		},
	]
}

/** Ce qu'un grant a produit, pour la réponse HTTP du pont et les logs. */
export interface SiteGiftResult {
	accountId: number
	/** Le solde de jetons APRÈS le crédit. */
	balance: number
	/** L'id de la box créée. */
	giftId: number
}

/**
 * Crédite `tokens` jetons à `accountId` et lui laisse une box du même montant.
 *
 * Les frames sont best-effort : les jetons sont crédités et la box stockée avant que la
 * première ne parte, et un joueur hors ligne retrouve les deux à sa prochaine connexion.
 */
export async function grantSiteCredits(
	env: SiteGiftEnv,
	accountId: number,
	tokens: number,
	startingTokens: number,
	message: string = SITE_PURCHASE_MESSAGE
): Promise<SiteGiftResult> {
	await ensureStartingBalances(env.DB, accountId, startingTokens)
	const balance = await creditCurrency(
		env.DB,
		accountId,
		CurrencyType.RecCenterTokens,
		tokens,
		startingTokens
	)
	const content = siteGiftContent(tokens, message)
	const gift = await createGift(env.DB, accountId, content)

	try {
		await env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayers(
			giftFrames(accountId, balance, gift.id, content)
		)
	} catch (err) {
		console.error(
			`site gift: could not notify account ${accountId} of box ${gift.id}: ${err instanceof Error ? err.message : String(err)}`
		)
	}

	return { accountId, balance, giftId: gift.id }
}

/**
 * Le même grant, mais désigné par le PSEUDO du joueur (celui du site et du jeu sont les
 * mêmes) : renvoie null quand aucun compte ne porte ce pseudo, pour que le pont réponde
 * 404 au lieu de créditer le mauvais joueur.
 */
export async function grantSiteCreditsByUsername(
	env: SiteGiftEnv,
	username: string,
	tokens: number,
	startingTokens: number,
	message: string = SITE_PURCHASE_MESSAGE
): Promise<SiteGiftResult | null> {
	const account = await getAccountByUsername(env.DB, username)
	if (account === null) return null
	return grantSiteCredits(env, account.accountId, tokens, startingTokens, message)
}

/** Ce qu'un retrait a produit, pour la réponse du pont. */
export interface SiteDebitResult {
	accountId: number
	/** Le solde APRÈS le retrait. */
	balance: number
	/** Ce qui a réellement été retiré (le solde ne descend jamais sous 0). */
	removed: number
}

/**
 * RETIRE des jetons à un compte — l'inverse du grant, sans box : le joueur n'a rien
 * acheté, l'administration corrige (erreur de saisie, triche, remboursement). Le solde
 * ne descend jamais sous 0 : demander plus que le solde vide le compte, et `removed`
 * dit ce qui est vraiment parti, pour que le site puisse l'annoncer honnêtement.
 */
export async function debitSiteCreditsByUsername(
	env: SiteGiftEnv,
	username: string,
	tokens: number,
	startingTokens: number
): Promise<SiteDebitResult | null> {
	const account = await getAccountByUsername(env.DB, username)
	if (account === null) return null

	await ensureStartingBalances(env.DB, account.accountId, startingTokens)
	const row = await env.DB.prepare(
		'SELECT amount FROM balance WHERE account_id = ?1 AND currency_type = ?2'
	)
		.bind(account.accountId, CurrencyType.RecCenterTokens)
		.first<{ amount: number }>()
	const current = Number(row?.amount ?? 0)
	const removed = Math.min(Math.max(0, Math.trunc(tokens)), Math.max(0, current))
	const balance = current - removed

	if (removed > 0) {
		await env.DB.prepare(
			'UPDATE balance SET amount = ?3 WHERE account_id = ?1 AND currency_type = ?2'
		)
			.bind(account.accountId, CurrencyType.RecCenterTokens, balance)
			.run()
		// Le joueur connecté voit son solde changer tout de suite ; hors ligne, il le lit
		// à sa prochaine requête de solde.
		try {
			await env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayers([
				{
					playerId: account.accountId,
					notificationType: NotificationType.StorefrontBalanceUpdate,
					data: {
						Balance: balance,
						CurrencyType: CurrencyType.RecCenterTokens,
						Platform: ALL_PLATFORMS,
					} satisfies BalanceResponsePayload,
				},
			])
		} catch (err) {
			console.error(
				`site debit: could not notify account ${account.accountId}: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	return { accountId: account.accountId, balance, removed }
}
