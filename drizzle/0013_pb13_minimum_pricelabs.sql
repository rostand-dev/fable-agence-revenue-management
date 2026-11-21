-- L'alerte « minimum PriceLabs sous le plancher » (reason_code MIN_PRICE_BELOW_FLOOR) portait le code PB-11, réservé dans le
-- blueprint (§9.5) au playbook BASE_LOW (hausse graduelle du prix de base). Elle devient PB-13.
-- Les situations déjà enregistrées sont renommées, clé de dédoublonnage comprise (`propertyId|playbook|dedupe`, voir
-- services/review.ts) : sans cela, la prochaine revue ouvrirait un doublon de chaque alerte encore ouverte.
-- Le journal d'audit n'est pas modifié (ajout seul) ; il ne contient pas le code playbook.
-- Rejouable : le filtre ne retient plus aucune ligne une fois le renommage fait.
UPDATE "opportunities"
SET "playbook" = 'PB-13',
	"dedupe_key" = replace("dedupe_key", '|PB-11|', '|PB-13|')
WHERE "playbook" = 'PB-11' AND "reason_code" = 'MIN_PRICE_BELOW_FLOOR';
