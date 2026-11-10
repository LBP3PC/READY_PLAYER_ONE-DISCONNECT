/**
 * Les drapeaux de compte que le SITE pilote sur le serveur de jeu :
 *
 *  - REC BLUE Plus (`hasPlus`) AVEC SA DATE (`plusUntil`) : le site vend l'abonnement
 *    avec une date de fin, et la page d'abonnement du jeu doit afficher cette même date
 *    au lieu d'un « dans un an » recalculé à chaque appel.
 *  - Le bannissement (`banned`, `banReason`, `banUntil`) : un compte banni n'obtient plus
 *    de jeton, donc il ne peut plus entrer dans le jeu.
 *
 * Ces valeurs vivent dans le blob JSON de la table `account` (voir accounts-db), lue ici
 * en SQL direct : ce sont des champs que le DTO du client n'expose pas, et le worker `auth`
 * les relit de la même façon pour refuser la connexion.
 */

/** Ce que le site peut lire sur un compte. */
export interface AccountFlags {
	/** Date de fin du Plus (ISO-8601), ou null. */
	plusUntil: string | null
	banned: boolean
	banReason: string
	/** Fin du bannissement (ISO-8601), ou null pour un bannissement définitif. */
	banUntil: string | null
	/**
	 * Badge « Certifié REC BLUE » : c'est le rôle `influencer` du jeu. `auth` le recopie
	 * dans le claim `role` du jeton, et c'est ce claim que le client affiche comme badge
	 * influenceur — le site et le jeu montrent donc la même chose.
	 */
	certified: boolean
}

/** Lit les drapeaux d'un compte ; un compte inconnu renvoie des valeurs neutres. */
export async function readAccountFlags(db: D1Database, accountId: number): Promise<AccountFlags> {
	const row = await db
		.prepare(
			`SELECT json_extract(data, '$.plusUntil') AS plusUntil,
			        json_extract(data, '$.banned') AS banned,
			        json_extract(data, '$.banReason') AS banReason,
			        json_extract(data, '$.banUntil') AS banUntil,
			        coalesce(json_extract(data, '$.isInfluencer'),
			                 json_extract(data, '$.isCertified')) AS certified
			 FROM account WHERE account_id = ?1`
		)
		.bind(accountId)
		.first<{
			plusUntil: string | null
			banned: number | null
			banReason: string | null
			banUntil: string | null
			certified: number | null
		}>()
	return {
		plusUntil: row?.plusUntil ?? null,
		banned: row?.banned === 1,
		banReason: row?.banReason ?? '',
		banUntil: row?.banUntil ?? null,
		certified: row?.certified === 1,
	}
}

/**
 * Donne le Plus jusqu'à `until` (ISO-8601), ou le retire avec `null`. `hasPlus` et la date
 * vont ensemble : c'est `hasPlus` que `auth` recopie dans le jeton, la date n'est qu'un
 * affichage — mais les deux doivent dire la même chose.
 */
export async function setPlus(
	db: D1Database,
	accountId: number,
	until: string | null
): Promise<void> {
	if (until === null) {
		await db
			.prepare(
				`UPDATE account SET data = json_set(data, '$.hasPlus', json('false'), '$.plusUntil', NULL)
				 WHERE account_id = ?1`
			)
			.bind(accountId)
			.run()
		return
	}
	await db
		.prepare(
			`UPDATE account SET data = json_set(data, '$.hasPlus', json('true'), '$.plusUntil', ?2)
			 WHERE account_id = ?1`
		)
		.bind(accountId, until)
		.run()
}

/**
 * Les rôles d'ÉQUIPE du jeu, pilotés par le site : `isModerator` (modérateur bénévole,
 * avec l'outil de communication d'équipe) et `isDeveloper` (staff/administrateur).
 * `auth` les recopie dans le claim `role` du jeton, qui est ce que le client lit pour
 * afficher l'étiquette et ouvrir les outils de modération.
 *
 * `role` est le rôle du SITE : un administrateur reçoit les deux drapeaux en jeu (il a
 * les pouvoirs du modérateur), un modérateur seulement `isModerator`, un membre aucun.
 */
export async function setRoles(
	db: D1Database,
	accountId: number,
	role: 'member' | 'moderator' | 'admin'
): Promise<{ isModerator: boolean; isDeveloper: boolean }> {
	const isModerator = role === 'moderator' || role === 'admin'
	const isDeveloper = role === 'admin'
	await db
		.prepare(
			`UPDATE account SET data = json_set(data,
			   '$.isModerator', json(?2), '$.isDeveloper', json(?3))
			 WHERE account_id = ?1`
		)
		.bind(accountId, isModerator ? 'true' : 'false', isDeveloper ? 'true' : 'false')
		.run()
	return { isModerator, isDeveloper }
}

/**
 * Le badge « Certifié REC BLUE » est le rôle `influencer` du jeu : on écrit `isInfluencer`
 * (et `isCertified`, la même information pour une lecture directe en base). C'est `auth`
 * qui, au login suivant, met `influencer` dans le claim `role` du jeton — donc le badge
 * apparaît dans le jeu, pas seulement sur le site.
 */
export async function setCertified(db: D1Database, accountId: number, certified: boolean): Promise<void> {
	await db
		.prepare(
			`UPDATE account SET data = json_set(data, '$.isInfluencer', json(?2),
			                                    '$.isCertified', json(?2))
			 WHERE account_id = ?1`
		)
		.bind(accountId, certified ? 'true' : 'false')
		.run()
}

/**
 * Le rôle `developer` SEUL — le badge Créateur/Dev que le client dessine sur la plaque de
 * nom — sans toucher à la modération (`isModerator`) ni au rôle d'équipe du site : `auth`
 * recopie `isDeveloper` dans le claim `role` du jeton au login suivant, et c'est ce claim
 * que le client lit.
 */
export async function setDeveloper(
	db: D1Database,
	accountId: number,
	developer: boolean
): Promise<void> {
	await db
		.prepare(
			`UPDATE account SET data = json_set(data, '$.isDeveloper', json(?2))
			 WHERE account_id = ?1`
		)
		.bind(accountId, developer ? 'true' : 'false')
		.run()
}

/** Bannit (avec motif et fin facultative) ou débannit un compte. */
export async function setBan(
	db: D1Database,
	accountId: number,
	ban: { reason: string; until: string | null } | null
): Promise<void> {
	if (ban === null) {
		await db
			.prepare(
				`UPDATE account SET data = json_set(data, '$.banned', json('false'),
				                                    '$.banReason', NULL, '$.banUntil', NULL)
				 WHERE account_id = ?1`
			)
			.bind(accountId)
			.run()
		return
	}
	await db
		.prepare(
			`UPDATE account SET data = json_set(data, '$.banned', json('true'),
			                                    '$.banReason', ?2, '$.banUntil', ?3)
			 WHERE account_id = ?1`
		)
		.bind(accountId, ban.reason, ban.until)
		.run()
}
