#!/bin/sh
# Génère assets/config.js au démarrage du conteneur à partir des variables d'environnement.
# Une valeur absente, vide ou qui n'est pas une adresse https simple garde l'adresse par défaut écrite dans index.html.
set -eu

CONFIG=/usr/share/nginx/html/assets/config.js

NL="$(printf '\nx')"; NL="${NL%x}"
CR="$(printf '\r')"

valid() {
  # La valeur entière est contrôlée : un saut de ligne ferait valider grep ligne par ligne.
  case "$1" in *"$NL"*|*"$CR"*) return 1 ;; esac
  # https uniquement, sans guillemet ni caractère qui pourrait sortir de la chaîne JavaScript.
  printf '%s' "$1" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
}

APP="${LANDING_APP_URL:-}"
DEMO="${LANDING_DEMO_URL:-}"

if [ -n "$APP" ] && ! valid "$APP"; then echo "[landing] LANDING_APP_URL ignorée (adresse https attendue)" >&2; APP=""; fi
if [ -n "$DEMO" ] && ! valid "$DEMO"; then echo "[landing] LANDING_DEMO_URL ignorée (adresse https attendue)" >&2; DEMO=""; fi

# Un échec d'écriture (système de fichiers en lecture seule, autre utilisateur) ne doit pas empêcher nginx de démarrer :
# les adresses écrites dans index.html restent alors en vigueur.
if ! {
  echo "/* Généré au démarrage du conteneur (docker/40-config.sh). Ne pas modifier à la main. */"
  echo "window.NS_LINKS = {"
  echo "  app: \"${APP}\","
  echo "  demo: \"${DEMO}\""
  echo "};"
} > "$CONFIG" 2>/dev/null; then
  echo "[landing] config.js non écrit : adresses de index.html conservées" >&2
  exit 0
fi

echo "[landing] adresses : application=${APP:-défaut} démo=${DEMO:-défaut}"
