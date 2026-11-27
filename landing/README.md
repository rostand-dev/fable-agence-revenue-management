# NuitSignal — landing (nuitsignal.rosyops.io)

Site vitrine statique de NuitSignal : HTML, CSS et JavaScript sans framework, sans dépendance et sans traceur.
Thème clair ou sombre selon le réglage de l'appareil (`prefers-color-scheme`), bouton pour forcer l'inverse,
animations coupées si l'appareil demande moins de mouvement (`prefers-reduced-motion`).

## Contenu

| Chemin | Rôle |
|---|---|
| `index.html` | La page. Les adresses par défaut de l'application et de la démo sont écrites dans les liens (le site marche sans JavaScript). |
| `assets/landing.css`, `assets/landing.js` | Styles (jetons « Deep Space » en sombre, « Aube » en clair) et animations. |
| `assets/theme.js` | Applique le thème avant l'affichage (pas de flash). |
| `assets/config.js` | Adresses de l'application et de la démo, régénéré au démarrage du conteneur. |
| `assets/avatars/` | Copie des portraits v2 de l'application (`public/avatars/v2`). |
| `assets/shots/` | Captures réelles de l'application sur le jeu de démonstration (bureau 1440 px, mobile 390 px en mode poche). |
| `assets/fonts/` | JetBrains Mono et Space Grotesk, hébergées ici (licence SIL OFL 1.1, fichiers `LICENSE-*`). |
| `nginx.conf`, `Dockerfile`, `docker/40-config.sh`, `docker/security-headers.conf` | Image de production : nginx non privilégié, port 8080, en-têtes de sécurité (CSP stricte), cache. |
| `e2e/`, `playwright.config.ts` | Tests navigateur (bureau, tablette, 390 et 360 px). Variables : `LANDING_BASE_URL` (adresse à tester ; absente = serveur statique local), `LANDING_EXPECTED_APP_URL` (adresse d'application attendue dans `config.js`), `E2E_CHROME_PATH` (Chrome local). |

## Travailler en local

```bash
cd landing && python3 -m http.server 4173      # puis http://127.0.0.1:4173
npm run e2e:landing                             # depuis la racine : tests Playwright de la landing
LANDING_BASE_URL=http://127.0.0.1:8080 npm run e2e:landing   # contre l'image Docker lancée (tests nginx compris)
```

## Variables d'environnement (conteneur)

Toutes facultatives. Coolify refuse une valeur vide : ne pas créer une variable qu'on ne renseigne pas.

| Variable | Description |
|---|---|
| `LANDING_APP_URL` | Adresse https de l'application, sans chemin final (ex. `https://connect.nuitsignal.rosyops.io`). « Commencer » et « Se connecter » y ajoutent `/inscription` et `/connexion`. Absente ou invalide : adresse écrite dans `index.html`. |
| `LANDING_DEMO_URL` | Adresse https complète de la démo publique en lecture seule (ex. `https://demo.nuit-signal.rosyops.io/demo`). Absente ou invalide : adresse écrite dans `index.html`. |

## Déploiement Coolify

1. Nouvelle ressource **Application** sur ce dépôt, branche `main`.
2. Build pack **Dockerfile**, *Base Directory* `/landing`, *Dockerfile Location* `/Dockerfile`, port exposé **8080**.
3. Domaine : `https://nuitsignal.rosyops.io` (et `https://www.nuitsignal.rosyops.io` redirigé vers le domaine nu si souhaité).
4. *Watch Paths* : `landing/**`, pour ne reconstruire la landing que si elle change.
5. Health check : `GET /healthz` (port 8080).
6. Variables `LANDING_APP_URL` et `LANDING_DEMO_URL` si les adresses diffèrent de celles du HTML.

Dans l'application NuitSignal existante, ajouter de son côté la *Watch Path* `!landing/**` (ou lister ses propres dossiers)
pour qu'une modification de la landing ne redéploie pas l'application.

## Mettre à jour les captures

Les captures viennent de l'application lancée en local avec le compte de démo (`DEMO_ACCOUNT_*`), écrans
Opportunités, Dossier et Fiche logement, à 1440 × 900 (bureau) et 390 × 844 (mobile, mode poche), converties en WebP
(1600 px de large pour le bureau, 600 px pour le mobile). Remplacer les fichiers de `assets/shots/` en gardant leur nom.
