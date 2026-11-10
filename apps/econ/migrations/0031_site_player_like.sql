-- Les likes donnés depuis le site, un par couple (compte du site, compte de jeu).
-- Le compte du site est l'UUID Supabase ; le compte de jeu est l'account_id D1.
-- La table ne stocke aucun like de jeu : ceux-ci restent dans `reputation`.
CREATE TABLE IF NOT EXISTS site_player_like (
  liker TEXT NOT NULL,
  target_account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (liker, target_account_id)
);

CREATE INDEX IF NOT EXISTS idx_site_player_like_target
  ON site_player_like (target_account_id);
