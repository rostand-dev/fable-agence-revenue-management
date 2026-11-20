# NuitSignal — agence de revenue management assistée par IA

Application web responsive pour les propriétaires de locations de courte durée (Airbnb, Booking.com) qui veulent un revenue management d'agence sans la prestation. Une équipe de huit agents IA surveille chaque jour le calendrier, explique ce qui se passe et instruit les décisions ; **PriceLabs reste le moteur de prix, le propriétaire garde la validation**.

Construit à partir du *Blueprint produit et technique V1* et du Design System NuitSignal (`design-system/`).

## Ce que fait cette version

- **Comptes multi-propriétaires** : inscription par e-mail, espace isolé par propriétaire.
- **Revue de chaque logement à son rythme** (J+0 à J+90 ; lectures et revues plus ou moins fréquentes selon la dynamique du logement et de son marché) : signaux → diagnostic causal → options → simulation en revenu net → audit → file priorisée.
- **Playbooks** : PB-01 rythme faible, PB-02 rythme en avance, PB-03 trou de calendrier, PB-05 cumul de remises, PB-06 passage sous le plancher (veto), PB-07 événement, PB-10 donnée périmée.
- **Dossier de décision** : preuves sourcées, arbre de diagnostic, hypothèses alternatives, options comparées (dont l'inaction), cascade du prix publié à la contribution, verdict d'audit règle par règle.
- **Cycle d'action tracé** : approuver → exécuter → vérifier → mesurer, avec machine à états, retour arrière et journal d'audit en ajout seul.
- **Équipe IA** : huit postes avec fiche de poste, workflows, activité et conversation.
- **Création d'un logement (funnel guidé)** : six étapes plein écran, sans menu latéral (`/logements/nouveau` puis `/logements/<id>/creation`) — le logement, SuperHote, PriceLabs, règles de vente (séjour minimum, majorations par canal), coûts et seuils, vérification. Chaque passage d'étape enregistre la saisie et l'étape où reprendre ; « Enregistrer et quitter » est toujours disponible, et la liste des logements propose « Reprendre la création ». SuperHote et PriceLabs peuvent être reportés, mais l'observation ne se lance pas sans PriceLabs. Le parcours « Coûts et seuils » pas à pas avec la chargée d'onboarding (commissions relevées sur les réservations, taxe de séjour, ménage, coût d'une nuit, seuil de dérangement, charges fixes, objectif) → planchers par canal et par durée de séjour. Une réponse absente reste *inconnue* ; une estimation peut être marquée *provisoire* et les dossiers la signalent.

### Limites connues, assumées

| Sujet | État |
|---|---|
| Données | Deux logements de **démonstration** (données synthétiques). Un logement réel lit **PriceLabs** dès que sa clé API est renseignée : grille J+0 à J+90, marché, réglages de prix et réservations relayées par le PMS. SuperHote se branche en lecture seule par jeton API (voir plus bas) ; les réservations et les prix restent lus via PriceLabs. |
| Écriture PriceLabs | **Simulée** sur les logements de démonstration ; **lecture seule** sur les logements réels (procédure manuelle guidée pour appliquer une décision). |
| Promotions et événements | Non fournis par PriceLabs : le registre des promotions reste manuel, les événements ne sont pas détectés sur les logements réels. |
| Promotions Airbnb / Booking.com | Procédure manuelle guidée avec preuve. Aucune automatisation de navigateur. |
| Modèle de vente | Heuristique simple et affichée comme telle ; chaque montant est une simulation, pas une prévision. |
| LLM | Facultatif. Chaque propriétaire saisit sa clé Anthropic (Intégrations, chiffrée) et choisit un modèle par agent (Réglages ou fiche agent) dans une liste alimentée par les modèles que sa clé peut utiliser. `ANTHROPIC_API_KEY` reste un repli serveur ; sans aucune clé, synthèses et réponses sont composées par règles. Les calculs et garde-fous n'utilisent jamais de LLM. |

## L'agence

| Agent | Poste | Écriture |
|---|---|---|
| Lina | Directrice du revenue management | aucune |
| Inès | Chargée d'onboarding et des données | aucune |
| Noor | Analyste marché | aucune |
| Elias | Stratège tarifaire | PriceLabs, sur approbation |
| Hugo | Responsable distribution et promotions | manuelle guidée |
| Maya | Responsable qualité d'annonce | aucune |
| Victor | Auditeur des décisions (veto, indépendant) | aucune |
| Théo | Chargé du reporting propriétaire | aucune |

Définitions complètes : `src/lib/agents/registry.ts` (postes, responsabilités, limites, workflows).

## Architecture

Monolithe modulaire TypeScript : Next.js (App Router) + PostgreSQL + Drizzle ORM, un seul conteneur applicatif.

```
src/lib/engine/     moteur déterministe, sans E/S : économie, métriques, détection, audit, machine à états
src/lib/agents/     registre des postes, passerelle LLM
src/lib/services/   revue, rythme de suivi et planificateur, décisions, rédaction, conversation, démonstration
src/db/             schéma et accès PostgreSQL ; migrations SQL dans drizzle/
src/app/            écrans et actions serveur
```

Écarts par rapport au blueprint, pour tenir dans un seul service simple à exploiter : pas de NestJS, Redis ni BullMQ (la revue est planifiée dans le processus, toutes les 15 minutes, une fois par jour et par propriétaire après 06:00 Europe/Paris) ; Drizzle à la place de Prisma ; authentification par e-mail et mot de passe à la place d'OIDC/MFA ; isolation par propriétaire appliquée dans le code, sans Row Level Security.

## Connexion PriceLabs

La clé API est rattachée à **un logement**, pas au compte : elle se saisit à la création du logement (étape 3 du parcours de création, confirmation de l'annonce comprise) ou dans sa fiche, onglet *PriceLabs*. Elle est vérifiée auprès de PriceLabs, chiffrée (AES-256-GCM, `APP_SECRET`) et n'est jamais réaffichée. Le rattachement à une annonce PriceLabs (identifiant + PMS) est toujours confirmé par le propriétaire, même s'il n'y en a qu'une, et une annonce ne peut alimenter qu'un seul de ses logements.

Code : `src/lib/integrations/pricelabs.ts` (client), `pricelabs-map.ts` (traduction, testée sur des réponses de forme réelle), `src/lib/services/pricelabs-sync.ts` (lecture avant chaque revue).

## Mot de passe oublié

Parcours : « Mot de passe oublié ? » sur la connexion → `/mot-de-passe-oublie` → e-mail Resend → `/reinitialisation/<jeton>` → nouveau mot de passe → connexion.

**Configuration Resend** (resend.com)

1. Ajoutez et vérifiez votre domaine dans *Domains* (enregistrements SPF, DKIM, et DMARC conseillé). Sans domaine vérifié, Resend n'envoie qu'à l'adresse de votre compte.
2. Créez une clé API (*API Keys*, droit « Sending access »), puis renseignez dans Coolify (*Environment Variables*) `RESEND_API_KEY` et `EMAIL_FROM` (ex. `NuitSignal <no-reply@votre-domaine.fr>`), et redéployez.
3. **Désactivez le suivi des clics** (*Click tracking*) du domaine : il réécrit les liens et ferait transiter le lien de réinitialisation par un tiers.

**Sécurité**

- Jeton de 32 octets aléatoires ; seul son hash SHA-256 est enregistré. Valable 30 min (`PASSWORD_RESET_MINUTES`), usage unique, un seul lien actif par utilisateur, consommé de façon atomique.
- Réponse, message et temps de réponse identiques que le compte existe ou non. Lien construit avec `APP_URL`, jamais avec l'en-tête `Host`.
- Limitation de débit en base : 3 demandes/heure/e-mail, 10/heure/IP, 10 essais de réinitialisation/heure/IP (clés enregistrées sous forme d'empreinte).
- Pages sans cache ni `Referer` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `noindex`). Le jeton n'est jamais journalisé en production.
- Nouveau mot de passe : 10 à 128 caractères, différent de l'ancien et de l'e-mail, refusé s'il figure dans les fuites connues (Have I Been Pwned, par k-anonymité ; sans blocage si le service est indisponible).
- Après changement : toutes les sessions sont fermées et un e-mail de confirmation est envoyé.
- E-mails : `src/lib/email/` (client Resend, gabarits HTML + texte, conçus mobile d'abord aux couleurs du design system).

## Inscription neutre (confirmation par e-mail)

Pour ne pas révéler quelles adresses ont déjà un compte, l'inscription ne crée rien tout de suite : la réponse est la même pour toute adresse (« Un e-mail vient d'être envoyé… », durée de réponse égalisée).

- **Adresse nouvelle** : e-mail avec un lien (1 h, usage unique, hash seul stocké). Le compte est créé au clic sur le bouton « Activer mon espace » de la page `/confirmation/<jeton>` (la simple ouverture du lien ne crée rien, pour résister aux aperçus et antivirus d'e-mail).
- **Adresse déjà inscrite** : e-mail « Vous avez déjà un espace » avec liens de connexion et de réinitialisation. Aucun doublon créé.
- Limitation : 3 inscriptions/heure/e-mail, 10/heure/IP.
- **Preview** : `SIGNUP_EMAIL_CONFIRMATION=false` rétablit la création immédiate du compte, sans e-mail (ce mode révèle les adresses déjà inscrites : à réserver aux environnements de test). En production avec la confirmation activée, Resend doit être configuré, sinon l'inscription affiche « momentanément indisponible ».

## Compte de démo (test/preview)

Pour ne plus recréer un compte à chaque déploiement de preview, l'application peut créer un compte propriétaire prêt à l'emploi (avec les deux logements de démonstration) au démarrage, juste après les migrations. Réservé aux environnements de test : **ne rien définir en production**.

Variables à poser sur le preview Coolify :

- `DEMO_ACCOUNT_ENABLED=true`
- `DEMO_ACCOUNT_ALLOWED_HOST=*.nuit-signal.rosyops.io` : le domaine de `APP_URL` doit correspondre. Le joker de tête exige un sous-domaine, donc il ne couvre pas la production `nuit-signal.rosyops.io`. Un motif exact (`preview.exemple.fr`) est aussi accepté.
- `DEMO_ACCOUNT_EMAIL` et `DEMO_ACCOUNT_PASSWORD` (10 caractères au moins)
- facultatif : `DEMO_ACCOUNT_NAME` (« Compte démo » par défaut)

Garde-fous : sans le drapeau, rien ne se passe et rien n'est consigné. Avec le drapeau mais un domaine non autorisé, un mot de passe trop court ou un e-mail invalide, le compte n'est pas créé et la raison est écrite dans les journaux, sans empêcher le démarrage. Si l'adresse existe déjà, rien n'est modifié : changer le mot de passe dans les variables n'écrase pas celui du compte existant (utiliser « Mot de passe oublié » ou supprimer le compte). Coolify refusant les valeurs vides, on peut simplement ne pas créer ces variables en production, ou mettre `DEMO_ACCOUNT_ENABLED=false` et `DEMO_ACCOUNT_ALLOWED_HOST=disabled`.

## Démo publique (lecture seule)

Pour laisser un visiteur essayer le produit sans compte, on déploie une **seconde application Coolify** depuis ce même dépôt (branche `main`, déploiement automatique, sa propre base, domaine fixe, « Preview Deployments » désactivés). Elle affiche les logements de démonstration en lecture seule.

**Application de la démo** (par exemple `demo.nuit-signal.rosyops.io`) :

- `DEMO_READONLY=true`
- `DEMO_ACCOUNT_ENABLED=true`, `DEMO_ACCOUNT_ALLOWED_HOST=demo.nuit-signal.rosyops.io`, `DEMO_ACCOUNT_EMAIL` et `DEMO_ACCOUNT_PASSWORD` (long et aléatoire : personne ne le saisit, `/demo` ouvre la session)
- `DEMO_SIGNUP_URL=https://nuit-signal.rosyops.io/inscription`
- ne définir ni clé Anthropic, ni Resend, ni PriceLabs, ni SuperHote : les agents restent en mode déterministe et aucun e-mail ne part.

**Production** : `DEMO_URL=https://demo.nuit-signal.rosyops.io` affiche « Voir la démo, sans compte » sur les pages de connexion. Sans cette variable, le bouton n'existe pas. Ne jamais définir `DEMO_READONLY` en production.

Comment ça marche :

- Un verrou central (`src/middleware.ts`) refuse tout ce qui n'est pas une lecture (les actions serveur sont des POST), sauf le suivi d'activité de session. Une action ajoutée plus tard est donc verrouillée d'office.
- `/demo` ouvre la session du compte de démo. Elle n'existe que si `DEMO_READONLY=true` **et** que le compte de démo est autorisé sur ce domaine ; ailleurs elle répond « introuvable ». Limitée à 60 ouvertures par heure et par adresse IP.
- Sur la démo, connexion, inscription et mot de passe oublié redirigent vers `/demo` (ou vers `DEMO_SIGNUP_URL`). Après 15 minutes d'inactivité, la session expire et `/demo` en rouvre une.
- Un bandeau « Démo en lecture seule » propose « Créer mon compte » ; un clic sur un formulaire affiche un message plutôt qu'une erreur.
- Les données persistent entre les redéploiements (le seed ne recrée rien s'il existe). Pour repartir de données neuves, supprimer le volume de la base dans Coolify.

## Prix publié estimé (majorations par canal)

Le prix qui fait foi auprès des voyageurs est celui de SuperHote, après une majoration en pourcentage propre à chaque canal. SuperHote ne l'expose pas : le propriétaire la saisit dans le dossier du logement (« Majorations par canal »), à la création ou ensuite. Une majoration vide est **inconnue**, jamais 0 %.

- `price` (recommandé par PriceLabs) et `user_price` (envoyé à SuperHote) sont conservés séparément ; le moteur de prix n'y touche pas.
- Prix publié estimé = `price × (1 + majoration / 100)` (prix recommandé par PriceLabs), arrondi à l’euro à l’affichage, valeur exacte conservée ; `user_price` n’entre pas dans le calcul, il est affiché et conservé pour la comparaison avec SuperHote (`src/lib/pricing/published.ts`).
- **Commissions et montants** : SuperHote fait foi pour les réservations. `superhote-map.ts` lit `total_price`, `host_payout`, `price_details` (ménage, taxe de séjour) et `host_fees`. Le taux de commission suggéré dans « Coûts et seuils » = frais hôte ÷ montant payé hors taxe de séjour, avec la période des séjours ; une réservation au taux invraisemblable (> 40 %) est écartée et comptée ; le versement n'est pas un contrôle (sur Booking il retire d'autres frais). Les **frais de paiement Booking.com** sont déduits de l'écart de versement (total − taxe de séjour − commission − versement), en médiane des taux par réservation : 1,4 % sur l'API réelle (16/11/2026). PriceLabs ne sert plus que de repli (sa commission Airbnb est souvent à 0) et de contrôle croisé : les écarts de réservations sont signalés dans l'onglet SuperHote, jamais corrigés. Validé sur l'API réelle (16/11/2026) : `host_fees` en montants positifs, TVA hôte en ligne séparée (`value_added_tax_host`), taxe de séjour de type `guest_exclusive_tax_remitted_by_airbnb`.
- **Dictionnaire des montants** : `src/lib/money/dictionary.ts` décrit chaque montant (source, taxes, frais, devise, signe, statut) ; `docs/dictionnaire-montants.md` en est généré par `npm run docs:money`. Tout nouvel identifiant `xxxCents`, colonne `xxx_cents` ou constante `XXX_CENTS` doit y être ajouté, sinon le test `src/lib/money/dictionary.test.ts` échoue ; un montant nommé autrement (euros, `cents` seul) n'est pas détecté et doit y être ajouté à la main. Ce qui n'est pas établi y est marqué « inconnu », jamais supposé.
- **Capacités des intégrations** : `src/lib/integrations/capabilities.ts` décrit ce que le code sait réellement faire pour chaque fournisseur (lecture, écriture, état affiché) ; `docs/capacites-integrations.md` en est généré par `npm run docs:capabilities`. Toute écriture passe par `checkWrite` / `executionBlock` : une écriture non développée est refusée côté serveur, rejetée par l'auditeur et grisée dans la fiche du dossier. Ajouter une capacité, c'est l'ajouter au catalogue, sinon le test de synchronisation échoue.
- `src/lib/integrations/superhote-check.ts` prépare la comparaison avec le prix réel SuperHote (tolérance 1 €). Non branchée : le format de l'API SuperHote reste à valider sur un cas réel.

## Connexion SuperHote (lecture seule)

Le jeton API se saisit par logement, à la création du logement (étape 2 du parcours, avant PriceLabs ; facultatif, « Je le ferai plus tard ») ou plus tard dans l'onglet *SuperHote*, avec les seuls droits `rentals.read`, `calendar.read` et `reservations.read`. Il est vérifié, chiffré comme la clé PriceLabs, et le rattachement au logement SuperHote est toujours confirmé par le propriétaire (un logement SuperHote ne peut alimenter qu'un seul logement NuitSignal).

- **Canal des réservations** : celles que PriceLabs transmet sans canal reçoivent celui de SuperHote (rapprochement par identifiant, sinon par dates exactes d'arrivée et de départ si une seule réservation correspond). Une ambiguïté n'est jamais tranchée ; un choix manuel du propriétaire prime.
- **Comparaison des prix** : le prix de calendrier SuperHote est comparé au `user_price` PriceLabs sur les nuits libres (tolérance 1 €). Identiques : le prix du calendrier SuperHote est avant majoration par canal. La documentation SuperHote ne le précise pas, d'où cette vérification sur données réelles.
- SuperHote est relu avec PriceLabs avant chaque revue ; un échec SuperHote n'interrompt jamais la lecture PriceLabs.
- Code : `src/lib/integrations/superhote.ts` (client), `superhote-map.ts` (traduction, testée), `src/lib/services/superhote-read.ts` et `superhote-sync.ts`. Variable facultative `SUPERHOTE_API_BASE`.
- Point à valider sur un compte réel : la documentation ne précise pas la clé du tableau dans `result`, ni de filtre par logement sur `/reservations` ; le client est tolérant sur la forme et filtre côté serveur.

## Isolation entre propriétaires, journal d'audit et fonctions activées

- **Application** : chaque requête filtre par propriétaire (`tenant_id`), et des tests tentent explicitement des accès croisés (`npm run test:db`).
- **Base (RLS)** : la migration `0011` crée le rôle `nuitsignal_app` (sans connexion) et une politique `tenant_isolation` sur toutes les tables portant `tenant_id`. Avec `TENANT_RLS=on`, `withTenant()` (`src/db/tenant.ts`) endosse ce rôle le temps d'une transaction : la base ne montre ni n'accepte que les lignes du propriétaire, même si une requête oublie son filtre (elle ne protège pas d'une injection SQL arbitraire) ; ce rôle ne peut que lire et ajouter au journal d'audit. Aujourd'hui l'API et la page du journal d'audit passent par ce chemin ; les autres lectures s'y raccordent au fil des évolutions. `/api/health` affiche `tenantIsolation` : `unavailable` (rôle ou politiques absents), `available` (en place, non exigée), `enforced` (exigée) ; avec `TENANT_RLS=on` sans isolation, il répond 503. Le statut vient d'une sonde réelle (le rôle est endossé). Une base sans droit `CREATEROLE`, ou dont le propriétaire ne peut pas endosser le rôle, reste en `unavailable`. `TENANT_RLS=on` ne protège aujourd'hui que le chemin du journal d'audit : ce n'est pas encore une isolation globale.
- **Journal d'audit (US-012)** : ajout seul, garanti par des déclencheurs PostgreSQL ; chaque action serveur est déclarée dans `src/lib/audit/coverage.ts` (un test échoue sinon).
- **Fonctions activées (US-013)** : Réglages → « Fonctions activées ». Un drapeau ne peut que couper (écriture automatique par API, lectures planifiées, revue automatique), pour tout l'espace, un logement ou une intégration ; chaque changement est journalisé.

## Développement

```bash
cp .env.example .env        # renseigner DATABASE_URL
npm install
npm run dev                 # les migrations s'appliquent au démarrage
npm test                    # tests du moteur (planchers, cumul, cas dorés, machine à états)
npm run db:generate         # après une modification de src/db/schema.ts
npm run db:idempotent       # obligatoire juste après db:generate : rend la migration rejouable sans erreur (un test échoue sinon)
```

## Déploiement sur Coolify

1. **Projet → New Resource → Public/Private Repository**, choisir ce dépôt, branche `main`.
2. **Build Pack : Docker Compose**, fichier `docker-compose.yml` à la racine.
3. Coolify génère le mot de passe PostgreSQL (`SERVICE_PASSWORD_POSTGRES`) et l'URL du service `app`. Dans **Domains** du service `app`, saisir votre domaine (par exemple `https://rm.rosyops.io`) — le port interne est 3000.
4. `APP_SECRET` est générée par Coolify (`SERVICE_PASSWORD_64_APPSECRET`) : ne la modifiez pas ensuite, elle chiffre les clés API enregistrées (PriceLabs, Anthropic). Facultatif, dans **Environment Variables** : `ANTHROPIC_API_KEY` (clé de repli partagée ; chaque propriétaire peut saisir la sienne dans l'application), `ANTHROPIC_MODEL` (modèle par défaut) et `SESSION_IDLE_MINUTES` (minutes d'inactivité avant déconnexion automatique, 15 par défaut, minimum 2 ; redéployer après modification). Pour le **mot de passe oublié** : `RESEND_API_KEY`, `EMAIL_FROM` (domaine vérifié dans Resend) et, facultatifs, `EMAIL_REPLY_TO` et `PASSWORD_RESET_MINUTES` (30 par défaut). `SIGNUP_EMAIL_CONFIRMATION` (`true` par défaut ; `false` en preview pour s'inscrire sans e-mail de confirmation). `TENANT_RLS` (`off` par défaut ; `on` pour exiger l'isolation par la base, voir « Isolation entre propriétaires »). Pour le compte de démo du preview : voir « Compte de démo (test/preview) ». Voir les sections « Mot de passe oublié » et « Inscription neutre ».
5. **Deploy**. Contrôle : `https://<domaine>/api/health` répond `{"status":"ok"}`.
6. Ouvrir le domaine, créer votre compte : les deux logements de démonstration s'installent et la première revue s'exécute.

Les données vivent dans le volume `nuitsignal-db` : pensez à activer une sauvegarde de ce volume dans Coolify.
