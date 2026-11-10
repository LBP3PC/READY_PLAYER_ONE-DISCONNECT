-- Le plafond de niveaux par jour (six), porté par la ligne de progression.
--
-- `levels_day` est le jour civil UTC (`YYYY-MM-DD`) auquel `levels_today` se rapporte, et
-- `levels_today` le nombre de niveaux déjà payés ce jour-là. Un jour différent remet le
-- compte à zéro au moment du gain suivant, sans balayage ni tâche planifiée.
--
-- Le plafond vit sur la ligne — pas dans l'appelant — pour que deux récompenses qui
-- arrivent ensemble partagent la même réserve de six niveaux.
--
-- Kept in sync with PROGRESSION_SCHEMA_DDL in packages/domain/src/progression-db.ts.

ALTER TABLE progression ADD COLUMN levels_day TEXT;
ALTER TABLE progression ADD COLUMN levels_today INTEGER NOT NULL DEFAULT 0;
