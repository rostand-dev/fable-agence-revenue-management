# Épic 9 — Exécution PriceLabs

Blueprint E9 (P1, « sous réserve d'accès ») : US-090 (adaptateur d'application et de vérification, idempotent), US-091 (contrôle des préconditions sur la configuration courante), US-092 (instantanés avant/après et reçu externe), US-093 (retour arrière et coupe-circuit), US-094 (alertes sur échec ou dérive). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 8).** L'exécution d'une action `API_PRICELABS` n'existait qu'en simulation : sur un logement de démonstration, `execute()` modifiait la grille locale ; sur un logement réel, `pricelabs.write` était « DEMO_ONLY » et seule la procédure manuelle guidée était possible. Le coupe-circuit (US-002), les drapeaux (US-013), la machine à états (US-065) et le rôle « exécuter » (US-084) existaient déjà. L'épic 9 branche la **vraie** écriture sans toucher à ces garde-fous : elle s'y ajoute.

## Principes de l'épic

1. **Fermé par défaut.** Aucune écriture vers un vrai compte PriceLabs tant que la variable d'environnement `PRICELABS_WRITE_ENABLED=true` n'est pas posée sur l'environnement. Sur Staging, rien ne change tant qu'elle est absente.
2. **Une seule porte vers l'extérieur.** Toute écriture passe par `executionBlock` / `checkWrite` (capacité, coupe-circuit, drapeau `write.api`, logement ACTIVE) puis par le service d'écriture ; les agents n'importent aucun module d'écriture (contrôle statique US-075 étendu).
3. **Valeurs absolues, jamais de delta.** Chaque écriture pose une valeur cible (prix minimum, prix de base, prix daté) : la rejouer donne le même état. C'est ce qui rend l'idempotence sûre.
4. **Relire avant et après.** On lit l'état réel avant d'écrire (US-091), on relit après pour confirmer (vérification), et on conserve les deux relevés (US-092).
5. **Échouer fermé.** Tout doute (lecture impossible, réponse illisible, écart) refuse l'écriture ou laisse l'action « Exécutée, non vérifiée » avec une alerte ; jamais d'écriture « à l'aveugle » ni de correction improvisée.
6. **Aucune régression des décisions** : golden cases inchangés, E2E complet sur trois largeurs.

## Contrat de l'API d'écriture PriceLabs (documentation officielle consultée le 2026-11-23)

| Besoin | Appel | Corps | Notes |
|---|---|---|---|
| Prix minimum / de base / maximum | `POST /v1/listings` | `{ listings: [{ id, pms, min?, base?, max? }] }` (valeurs dans la devise de l'annonce, pas en centimes) | Réponse non documentée : on la tient pour « acceptée » (2xx) et on **relit** `GET /v1/listings` pour confirmer. |
| Prix daté | `POST /v1/listings/{id}/overrides` | `{ pms, overrides: [{ date, price: "122", price_type: "fixed", currency?, reason? }] }` | Tout ou rien : une seule date invalide fait échouer toute la requête (400, rien d'enregistré). |
| Lecture des prix datés | `GET /v1/listings/{id}/overrides?pms=…&start_date=…&end_date=…` | — | Réponse `{ overrides: [{ date, price, price_type, min_stay, … }] }`. |
| Suppression de prix datés | `DELETE /v1/listings/{id}/overrides` | `{ pms, overrides: [{ date }] }` | 204, corps vide. |
| Limites | — | — | 60 requêtes/min, 1 000/h par clé ; 429 en cas de dépassement ; délai client conseillé de 300 s. |

**Ce que le code ne fait volontairement pas** : le séjour minimum daté (`MIN_STAY_OVERRIDE`). La documentation ne dit pas ce qu'une dérogation sans prix fait au prix déjà posé sur la date (l'exemple officiel utilise `price: "0"`, sens non documenté) : écrire à l'aveugle pourrait publier un prix nul. Cette action reste donc en **procédure manuelle guidée** sur un logement réel (elle reste simulée sur la démonstration). À rouvrir quand PriceLabs aura confirmé la sémantique.

| Type d'action | Écriture par API (logement réel) | Appel |
|---|---|---|
| Prix minimum (`MIN_PRICE_CHANGE`) | oui | `POST /listings` (`min`) |
| Prix de base (`BASE_PRICE_CHANGE`, avec `basePriceCents`) | oui | `POST /listings` (`base`) |
| Prix daté (`PRICE_OVERRIDE`) | oui | `POST …/overrides` (fixe) |
| Exclusion de règle (`RULE_EXCLUSION`) | oui | `POST …/overrides` (fixe) |
| Séjour minimum daté (`MIN_STAY_OVERRIDE`) | non : procédure manuelle | — |

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-090** Adaptateur apply/verify idempotent | Fondation : port d'écriture, journal d'idempotence, branchement dans `execute()` et `verify()`, ouverture contrôlée de la capacité. Tout le reste s'y appuie. |
| 2 | **US-091** Préconditions | S'insère dans l'application de l'US-090 : lire la configuration courante et refuser si elle a bougé depuis la simulation. Doit exister avant qu'on s'autorise à écrire réellement. |
| 3 | **US-092** Instantanés avant/après et reçu | Utilise les relectures de l'US-091 (avant) et de la vérification (après) ; fournit le « avant » dont le retour arrière a besoin. |
| 4 | **US-093** Retour arrière et coupe-circuit | Restaure l'« avant » de l'US-092 par l'API ; vérifie le coupe-circuit au moment de l'envoi. |
| 5 | **US-094** Alertes échec/dérive | Dernier : il observe les échecs, refus et écarts produits par les quatre précédentes et les affiche. |

**Garde-fous de non-régression** : `review-golden.test.ts` et `agents-golden.test.ts` inchangés ; suites unitaires et base de données complètes ; E2E complet sur trois largeurs (bureau, 390 et 360 px) ; contrôle statique « aucune écriture externe depuis les agents » étendu aux nouveaux modules ; rejeu double des migrations.

## Décisions prises pendant l'épic (à relire)

- **Variable `PRICELABS_WRITE_ENABLED`** (absente = écriture réelle fermée). Choix d'une variable d'environnement et non d'un réglage de l'application : c'est le geste de déploiement qui ouvre la porte, pas un clic dans l'interface, et Staging peut tester sans risque pour le compte PriceLabs réel.
- **Aucune écriture sur un logement en observation** (`SHADOW`) : règle existante, conservée.
- **Séjour minimum daté non écrit par API** : voir ci-dessus.
- **Clé API de lecture réutilisée pour l'écriture** : PriceLabs n'a qu'une clé par compte ; la clé de l'utilisateur sert aux deux. Si la clé n'a pas le droit d'écrire, PriceLabs répond 401/403 : l'action passe en échec avec un message clair et rien n'a été modifié.

## US-090 — Adaptateur d'écriture idempotent

**Ce qui change.** Une action approuvée sur un logement réel s'exécute par l'API PriceLabs, au lieu d'une écriture simulée, pour les quatre types du tableau ci-dessus. Le logement de démonstration reste simulé, pour tous les types.

- **Une seule porte** : `src/lib/services/pricelabs-write.ts` (préparer → envoyer → relire). Les agents et le moteur n'importent jamais le client d'écriture (test statique) ; le moteur n'importe que la liste pure `pricelabs-write-types.ts`.
- **Valeurs absolues** : on écrit « le prix minimum devient 95 € », jamais « +5 % ». Une variation en pourcentage est calculée sur le prix courant relu juste avant, arrondi à l'euro comme la simulation. Rejouer la même écriture donne le même état.
- **Journal d'idempotence** : table `external_writes` (migration `0025`, idempotente, isolée par propriétaire). La ligne est inscrite AVANT l'envoi, avec la clé unique `<action>:APPLY` : une seconde tentative sur la même action est refusée (« aucun second envoi »). États : `PENDING` → `SENT` → `CONFIRMED` ou `FAILED`.
- **Échouer fermé** : lecture impossible, annonce disparue, plan douteux (prix inconnu, plus de 31 dates, valeur non entière) = refus, action laissée APPROUVÉE, rien d'envoyé. Une écriture envoyée mais que la relecture ne retrouve pas est un **échec « non confirmée »**, jamais un succès supposé.
- **Coupe-circuit et verrou rappelés au moment de l'envoi**, après la lecture et après l'inscription au journal.
- **Reçu** : méthode, adresse, statut, date, empreinte de la requête (SHA-256 du contenu trié). Jamais la clé API, jamais de donnée de voyageur.
- **Vérification** (`verify()`) : relit chez PriceLabs et compare à ce qui a été écrit ; un écart ouvre l'événement d'audit `action.verification_failed`.
- **Verrou d'environnement `PRICELABS_WRITE_ENABLED`** : voir « Décisions ». Absent, la capacité s'affiche « Désactivée sur cet environnement » et rien ne part.
- **Retour arrière** : refusé pour une action écrite par API tant que l'US-093 n'est pas livrée (message explicite), pour ne jamais proposer un retour arrière simulé sur un prix réellement modifié.

**Tests ajoutés** : planification et conversions, contrat identique des adaptateurs mémoire et HTTP (contre le faux serveur, y compris 403, 500, 429 puis succès), absence de la clé dans les reçus, service sur base réelle (journal, idempotence, refus, relecture impossible, coupe-circuit, écart à la vérification, isolation), e2e « écriture désactivée » sur bureau, 390 et 360 px.

**Corrections issues de la relecture de code** : le journal reçoit le plan ET l'état d'avant (limites, prix datés bruts) AVANT l'envoi ; une réponse ambiguë (délai, coupure, 5xx) laisse le journal « envoyée » avec un message honnête (jamais « rien n'a été modifié ») ; un retour arrière est refusé dès que le journal montre une écriture partie, même sur une action « échouée » ; sur un logement réel, la grille locale n'est plus modifiée (elle se met à jour à la prochaine synchronisation) ; le plafond et le plancher de la stratégie s'appliquent aux prix calculés en %.

**Limites connues, assumées (suite dans les US suivantes)** :
- Une action restée « en exécution » après un arrêt brutal du serveur n'est pas réconciliée automatiquement : l'alerte et l'écran de reprise arrivent avec l'US-094 (le journal `external_writes` porte déjà l'état d'avant et le statut).
- Plus de 31 dates, ou prix courant inconnu pour un pourcentage : le refus tombe à l'exécution (action laissée APPROUVÉE) et non à la proposition.
- Le prix de base proposé se calcule sur la stratégie locale ; sa comparaison au prix de base distant est faite par l'US-091.

## US-091 — Préconditions avant écriture

Avant tout envoi, l'état réel chez PriceLabs est comparé à celui sur lequel la simulation a été faite (`src/lib/integrations/pricelabs-preconditions.ts`, fonction pure testée). Un refus laisse l'action **APPROUVÉE**, n'envoie rien, n'inscrit rien au journal d'écriture et ajoute l'événement d'audit `action.precondition_failed` (catégorie Exécution), avec la raison en clair.

| Contrôle | Règle |
|---|---|
| Synchronisation | Refus si `push_enabled` vaut faux chez PriceLabs (l'écriture n'aurait aucun effet). Valeur inconnue : pas de refus (assumé, PriceLabs ne la renvoie pas toujours). |
| Prix minimum | Doit valoir, chez PriceLabs, la valeur de départ figée dans l'action (`previousMinPriceCents`) ; à défaut, le minimum de la stratégie ; ni l'un ni l'autre = refus (« relancez la revue »). Déjà à la valeur cible = conforme (rejeu). |
| Prix de base | Écart ≤ 2 % avec le prix de base de départ figé dans l'action (`previousBasePriceCents`, à défaut la stratégie). |
| Contrôles croisés | minimum ≤ base ≤ maximum, uniquement pour les couples qui touchent un champ modifié : une incohérence préexistante sans rapport ne bloque pas. |
| Prix daté | Un prix daté différent déjà posé sur la date n'est pas écrasé. Le même prix est un rejeu inoffensif, sauf s'il porte un séjour minimum (que l'écriture effacerait) : refus. Prix fixe comparé aux minimum et maximum réels (choix prudent : la documentation PriceLabs ne dit pas si un prix fixe y est soumis). |
| Variation en % | La grille chez PriceLabs doit rester à ≤ 5 % (variation quotidienne maximale de la stratégie) des prix simulés, figés dans l'action par date (`simulatedPrices`) ; prix simulé ou réel inconnu = refus. |
| Rejeu | Une écriture déjà engagée pour l'action est détectée AVANT toute précondition (message « aucun second envoi »). |

Aucune migration, aucune variable d'environnement. Les dossiers créés avant cette US ne portent pas `simulatedPrices` : pour une variation en %, ils sont refusés avec « relancez la revue » (comportement voulu, échec fermé). Les tolérances (2 % et 5 %) sont des constantes du module, à ajuster ici si l'usage le demande.

## US-092 — Instantanés avant/après et reçu externe

Chaque écriture porte, dans sa ligne du journal `external_writes` (migration `0026`, idempotente : quatre colonnes ajoutées avec `IF NOT EXISTS`) :

- **l'état d'avant**, inscrit AVANT l'envoi, et **l'état d'après**, relu juste après (conservé aussi quand la relecture ne retrouve pas l'écriture : c'est la preuve de ce qui s'est passé) : limites, devise, synchronisation, prix de la grille et prix datés bruts sur les dates visées ;
- **une empreinte SHA-256** de chacun, recopiée dans l'exécution et dans l'événement d'audit `action.executed` ;
- **le reçu de l'appel** : méthode, adresse, statut HTTP, date d'envoi, empreinte de la requête.

La fiche dossier affiche ces éléments dans le panneau « Preuve d'écriture chez PriceLabs » (état de l'écriture, reçu, empreintes, tableau avant/après), lisible sans défilement horizontal sur bureau, 390 et 360 px. Aucune clé API ni donnée de voyageur n'y figure. Le rôle applicatif ne peut pas supprimer une ligne du journal ; il peut la mettre à jour (statut, reçu, état d'après). La protection contre une retouche est l'empreinte recopiée dans l'événement d'audit, append-only : comparer les empreintes de l'écran à celles de l'audit montre toute modification. L'empreinte porte sur le contenu de l'instantané, date de lecture exclue ; seuls les champs connus d'un prix daté sont conservés (liste blanche). Aucune nouvelle variable d'environnement.

*(Les sections des autres US sont ajoutées au fil de l'épic.)*
