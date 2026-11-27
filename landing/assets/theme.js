/* Thème et animations : appliqués avant l'affichage pour éviter un flash.
   « auto » suit le réglage clair/sombre de l'appareil ; « motion-off » mémorise la pause des animations demandée par le visiteur. */
(function () {
  var d = document.documentElement, t = "auto", m = null;
  try { t = localStorage.getItem("ns-theme") || "auto"; m = localStorage.getItem("ns-motion"); } catch (e) {}
  if (t !== "light" && t !== "dark") t = "auto";
  d.setAttribute("data-theme", t);
  if (m === "off") d.classList.add("motion-off");
  // Les animations d'apparition ne masquent le contenu que si le script principal a fini de s'initialiser ; sinon tout reste visible.
  d.classList.add("js");
  setTimeout(function () { if (!window.__nsReady) d.classList.remove("js"); }, 3000);
})();
