# syntax=docker/dockerfile:1
# NuitSignal — landing statique (nuitsignal.rosyops.io).
# Aucune étape de construction : les fichiers sont servis tels quels par nginx, en utilisateur non privilégié.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --chmod=0755 docker/40-config.sh /docker-entrypoint.d/40-config.sh
COPY --chown=nginx:nginx index.html 404.html robots.txt sitemap.xml /usr/share/nginx/html/
COPY --chown=nginx:nginx assets /usr/share/nginx/html/assets

# Variables d'environnement lues au démarrage par docker/40-config.sh (toutes facultatives ; ne pas les créer vides dans Coolify) :
# - LANDING_APP_URL : adresse https de l'application, sans chemin final (ex. https://connect.nuitsignal.rosyops.io). Les boutons
#   « Commencer » et « Se connecter » y ajoutent /inscription et /connexion. Absente ou invalide : adresse écrite dans index.html.
# - LANDING_DEMO_URL : adresse https complète de la démo publique en lecture seule (ex. https://demo.nuit-signal.rosyops.io/demo).
#   Absente ou invalide : adresse écrite dans index.html.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
