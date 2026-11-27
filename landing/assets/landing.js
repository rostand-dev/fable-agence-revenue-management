/* NuitSignal — landing : animations et interactions. Aucune dépendance, aucun traceur.
   Chaque module est isolé : si l'un échoue, les autres tournent et tout le contenu reste visible. */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  /** Vrai si l'appareil demande moins de mouvement ou si le visiteur a mis les animations en pause. */
  var still = function () { return reduce.matches || root.classList.contains("motion-off"); };
  var motionListeners = [];
  var onMotion = function (fn) { motionListeners.push(fn); };
  var failed = false;
  function mod(name, fn) { try { fn(); } catch (e) { failed = true; console.error("[landing] module « " + name + " » : " + (e && e.message)); } }
  function onView(el, fn, opts) {
    if (!el) return;
    new IntersectionObserver(function (es) { es.forEach(function (e) { fn(e.isIntersecting, e); }); }, opts || { threshold: .25 }).observe(el);
  }
  function isDark() { var t = root.getAttribute("data-theme"); return t === "dark" || (t === "auto" && darkMq.matches); }
  var sky = { refresh: function () {} };

  /* ---------- Liens vers l'application (config.js) ---------- */
  mod("liens", function () {
    var L = window.NS_LINKS || {};
    var ok = function (u) { return typeof u === "string" && /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(u); };
    var app = ok(L.app) ? L.app.replace(/\/+$/, "") : "";
    var targets = { login: app && app + "/connexion", signup: app && app + "/inscription", demo: ok(L.demo) ? L.demo : "" };
    $$("[data-href]").forEach(function (a) { var u = targets[a.getAttribute("data-href")]; if (u) a.href = u; });
  });

  /* ---------- Thème : appareil, ou l'inverse ---------- */
  mod("thème", function () {
    var btn = $("#themeBtn"); if (!btn) return;
    var labels = { auto: "Thème automatique, comme l'appareil", light: "Thème clair forcé", dark: "Thème sombre forcé" };
    function label() { btn.setAttribute("aria-label", labels[root.getAttribute("data-theme")] + ". Changer de thème"); }
    btn.addEventListener("click", function () {
      var t = root.getAttribute("data-theme") === "auto" ? (isDark() ? "light" : "dark") : "auto";
      root.setAttribute("data-theme", t);
      try { t === "auto" ? localStorage.removeItem("ns-theme") : localStorage.setItem("ns-theme", t); } catch (e) {}
      label(); sky.refresh();
    });
    label();
  });

  /* ---------- Pause globale des animations (WCAG 2.2.2) ---------- */
  mod("pause", function () {
    var btn = $("#motionBtn"); if (!btn) return;
    function sync() { btn.setAttribute("aria-pressed", String(root.classList.contains("motion-off"))); }
    btn.addEventListener("click", function () {
      var off = !root.classList.contains("motion-off");
      root.classList.toggle("motion-off", off);
      try { off ? localStorage.setItem("ns-motion", "off") : localStorage.removeItem("ns-motion"); } catch (e) {}
      sync(); motionListeners.forEach(function (f) { try { f(); } catch (e) {} });
    });
    sync();
  });

  /* ---------- Barre de navigation ---------- */
  mod("navigation", function () {
    var nav = $(".nav"); if (!nav) return;
    var ticking = false;
    function upd() { nav.classList.toggle("is-scrolled", window.scrollY > 12); ticking = false; }
    window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  });

  /* ---------- Ciel étoilé (nuit) / réseau de signaux (jour) ---------- */
  mod("ciel", function () {
    var c = $("#sky"); if (!c || !c.getContext) return;
    var ctx = c.getContext("2d"), stars = [], shots = [], w = 0, h = 0, raf = 0, visible = true, mx = 0, my = 0;
    var col = "226 232 255", alpha = .9, link = "167 139 250", dark = true;
    function readVars() {
      var cs = getComputedStyle(root);
      col = cs.getPropertyValue("--star").trim() || col; alpha = parseFloat(cs.getPropertyValue("--star-alpha")) || alpha;
      link = cs.getPropertyValue("--link-line").trim() || link; dark = isDark();
    }
    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = c.clientWidth; h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.round(Math.min(220, w * h / (dark ? 6500 : 11000)));
      stars = [];
      for (var i = 0; i < n; i++) stars.push({ x: Math.random() * w, y: Math.random() * h, z: Math.random() * .8 + .2, r: Math.random() * 1.3 + .3, t: Math.random() * 6.28, s: Math.random() * .02 + .005, vx: (Math.random() - .5) * .08, vy: (Math.random() - .5) * .08 });
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      var moving = !still(), ox = mx * 14, oy = my * 10;
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        if (moving) { s.t += s.s; if (!dark) { s.x = (s.x + s.vx + w) % w; s.y = (s.y + s.vy + h) % h; } }
        var a = alpha * (.45 + .55 * Math.abs(Math.sin(s.t))) * s.z, x = s.x + ox * s.z, y = s.y + oy * s.z;
        ctx.beginPath(); ctx.arc(x, y, s.r * (dark ? 1 : 1.3), 0, 6.283); ctx.fillStyle = "rgb(" + col + " / " + a.toFixed(3) + ")"; ctx.fill();
        if (!dark) {
          for (var j = i + 1; j < Math.min(stars.length, i + 14); j++) {
            var t = stars[j], dx = t.x - s.x, dy = t.y - s.y, d = dx * dx + dy * dy;
            if (d < 9000) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(t.x + ox * t.z, t.y + oy * t.z); ctx.strokeStyle = "rgb(" + link + " / " + (.16 * (1 - d / 9000)).toFixed(3) + ")"; ctx.lineWidth = 1; ctx.stroke(); }
          }
        }
      }
      if (!moving) { shots = []; return; }
      if (Math.random() < (dark ? .012 : .006) && shots.length < 3) shots.push({ x: Math.random() * w * .8, y: Math.random() * h * .5, l: 0, v: 6 + Math.random() * 5 });
      for (var k = shots.length - 1; k >= 0; k--) {
        var p = shots[k]; p.l += p.v; var len = Math.min(p.l, 140), x2 = p.x + p.l, y2 = p.y + p.l * .35;
        var g = ctx.createLinearGradient(x2 - len, y2 - len * .35, x2, y2);
        g.addColorStop(0, "rgb(" + link + " / 0)"); g.addColorStop(1, "rgb(" + link + " / .85)");
        ctx.beginPath(); ctx.moveTo(x2 - len, y2 - len * .35); ctx.lineTo(x2, y2); ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.stroke();
        if (p.l > 520) shots.splice(k, 1);
      }
    }
    function loop() { draw(); raf = visible && !still() && !doc.hidden ? requestAnimationFrame(loop) : 0; }
    function start() { if (!raf) loop(); }
    function refresh() { requestAnimationFrame(function () { readVars(); size(); draw(); start(); }); }
    new ResizeObserver(function () { readVars(); size(); draw(); }).observe(c);
    onView(c, function (v) { visible = v; if (v) start(); }, { threshold: 0 });
    doc.addEventListener("visibilitychange", start);
    window.addEventListener("pointermove", function (e) { mx = e.clientX / window.innerWidth - .5; my = e.clientY / window.innerHeight - .5; }, { passive: true });
    darkMq.addEventListener("change", refresh);
    onMotion(start);
    readVars();
    sky = { refresh: refresh };
  });

  /* ---------- Apparition au défilement ---------- */
  mod("apparition", function () {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -8% 0px", threshold: .08 });
    $$(".reveal").forEach(function (el) { io.observe(el); });
  });

  /* ---------- Slogan : décodage du signal ---------- */
  mod("slogan", function () {
    var glyphs = "01<>/\\#$%&*+=?NS", NBSP = " ";
    $$("[data-scramble]").forEach(function (el, idx) {
      var final = el.textContent, len = final.length;
      el.setAttribute("aria-hidden", "true"); // le h1 porte le slogan complet dans son aria-label
      if (still()) return;
      var start = null, dur = 900 + len * 22, delay = 150 + idx * 380;
      // espaces insécables : chaque ligne garde sa hauteur et sa largeur pendant le décodage (pas de saut de mise en page)
      el.textContent = final.replace(/\S/g, NBSP);
      requestAnimationFrame(function frame(ts) {
        if (start === null) start = ts + delay;
        if (still()) { el.textContent = final; return; }
        var p = Math.max(0, (ts - start) / dur), out = "";
        for (var i = 0; i < len; i++) {
          var ch = final[i], r = p * len * 1.25 - i * .25;
          out += ch === " " ? " " : r >= 1 ? ch : r > 0 ? glyphs[(Math.random() * glyphs.length) | 0] : NBSP;
        }
        el.textContent = out;
        if (p < 1) requestAnimationFrame(frame); else el.textContent = final;
      });
    });
  });

  /* ---------- Console de revue ---------- */
  mod("console", function () {
    var box = $(".console"), lines = $$("#console li"); if (!box || !lines.length) return;
    var running = false, timer = 0, inView = false, hover = false;
    function showAll() { running = false; clearTimeout(timer); lines.forEach(function (l) { l.classList.add("on"); l.classList.remove("typing"); }); }
    function play() {
      if (still() || hover || !inView) { showAll(); return; }
      running = true; lines.forEach(function (l) { l.classList.remove("on", "typing"); });
      var i = 0;
      (function next() {
        if (!running) return;
        if (i > 0) lines[i - 1].classList.remove("typing");
        if (i >= lines.length) { timer = setTimeout(play, 6500); return; }
        lines[i].classList.add("on", "typing"); i++;
        timer = setTimeout(next, i === lines.length ? 1400 : 950);
      })();
    }
    showAll();
    onView(box, function (v) { inView = v; if (v && !running) play(); if (!v) showAll(); });
    box.addEventListener("pointerenter", function () { hover = true; showAll(); });
    box.addEventListener("pointerleave", function () { hover = false; });
    onMotion(function () { if (still()) showAll(); else if (inView) play(); });
  });

  /* ---------- Compteurs ---------- */
  mod("compteurs", function () {
    $$("[data-count]").forEach(function (el) {
      var end = +el.getAttribute("data-count"), pre = el.getAttribute("data-prefix") || "", fin = el.textContent;
      onView(el, function (v) {
        if (!v || el.dataset.done || still()) return; el.dataset.done = "1";
        var t0 = performance.now();
        requestAnimationFrame(function f(t) { var p = Math.min(1, (t - t0) / 1400), e = 1 - Math.pow(1 - p, 3); el.textContent = p < 1 ? pre + Math.round(end * e) : fin; if (p < 1) requestAnimationFrame(f); });
      }, { threshold: .6 });
    });
  });

  /* ---------- Halo qui suit le pointeur ---------- */
  mod("halo", function () {
    $$(".glow").forEach(function (c) {
      c.addEventListener("pointermove", function (e) { var r = c.getBoundingClientRect(); c.style.setProperty("--mx", (e.clientX - r.left) + "px"); c.style.setProperty("--my", (e.clientY - r.top) + "px"); });
    });
  });

  /* ---------- Slider des agents ---------- */
  mod("slider", function () {
    var slider = $("#slider"), live = $("#slidesLive"), bar = $("#progress"); if (!slider || !bar) return;
    var slides = $$(".slide", slider), thumbs = $$("#thumbs button"), prev = $("#prev"), next = $("#next");
    if (!slides.length || slides.length !== thumbs.length) return;
    var idx = 0, typingTimer = 0, advTimer = 0, progRaf = 0, typing = false, hovering = false, focused = false, inView = false;
    var texts = slides.map(function (s) { return $("[data-say]", s).textContent; });
    // rotation possible seulement si rien ne l'interdit (APG : pas de rotation avec le focus dedans, ni au survol, ni en mouvement réduit)
    function canRun() { return inView && !hovering && !focused && !still(); }
    function stopAdvance() { clearTimeout(advTimer); cancelAnimationFrame(progRaf); bar.style.width = "0"; }
    function stopTyping() { clearTimeout(typingTimer); typing = false; slides[idx].classList.remove("is-speaking"); $("[data-say]", slides[idx]).textContent = texts[idx]; }
    function schedule(ms) {
      stopAdvance();
      live.setAttribute("aria-live", canRun() ? "off" : "polite");
      if (!canRun() || typing) return;
      var t0 = performance.now();
      progRaf = requestAnimationFrame(function pr(t) { bar.style.width = Math.min(100, (t - t0) / ms * 100) + "%"; if (t - t0 < ms) progRaf = requestAnimationFrame(pr); });
      advTimer = setTimeout(function () { go(idx + 1); }, ms);
    }
    function type() {
      var s = slides[idx], p = $("[data-say]", s), txt = texts[idx];
      clearTimeout(typingTimer);
      if (!canRun()) { typing = false; p.textContent = txt; s.classList.remove("is-speaking"); schedule(4200); return; }
      // le texte complet reste dans le DOM : la partie pas encore « dite » est transparente
      p.textContent = ""; var said = doc.createElement("span"), rest = doc.createElement("span");
      rest.className = "ghost-text"; rest.textContent = txt; p.appendChild(said); p.appendChild(rest);
      s.classList.add("is-speaking"); typing = true;
      var n = 0;
      (function step() {
        n = Math.min(txt.length, n + (txt[n] === " " ? 1 : 2));
        said.textContent = txt.slice(0, n); rest.textContent = txt.slice(n);
        if (n < txt.length) typingTimer = setTimeout(step, /[,.:;!?…]/.test(txt[n - 1]) ? 160 : 26);
        else { typing = false; s.classList.remove("is-speaking"); p.textContent = txt; schedule(4200); }
      })();
    }
    function go(i) {
      stopAdvance(); stopTyping();
      i = (i + slides.length) % slides.length;
      var old = slides[idx];
      if (i !== idx) { old.classList.add("is-leaving"); old.classList.remove("is-active"); setTimeout(function () { old.classList.remove("is-leaving"); }, 600); }
      idx = i;
      slides.forEach(function (s, k) { s.classList.toggle("is-active", k === i); s.setAttribute("aria-hidden", k === i ? "false" : "true"); if ("inert" in s) s.inert = k !== i; });
      thumbs.forEach(function (t, k) { t.setAttribute("aria-current", k === i ? "true" : "false"); });
      var th = thumbs[i], box = th.parentNode;
      box.scrollTo({ left: th.offsetLeft - box.clientWidth / 2 + th.clientWidth / 2, behavior: still() ? "auto" : "smooth" });
      type();
    }
    thumbs.forEach(function (t, k) { t.addEventListener("click", function () { go(k); }); });
    $("#thumbs").addEventListener("keydown", function (e) {
      var k = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: slides.length - 1 }[e.key];
      if (k === undefined) return;
      e.preventDefault(); go(k); thumbs[idx].focus();
    });
    if (prev) prev.addEventListener("click", function () { go(idx - 1); });
    if (next) next.addEventListener("click", function () { go(idx + 1); });
    slider.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") { hovering = true; schedule(0); } });
    slider.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") { hovering = false; schedule(3500); } });
    slider.addEventListener("focusin", function () { focused = true; schedule(0); });
    slider.addEventListener("focusout", function (e) { if (!slider.contains(e.relatedTarget)) { focused = false; schedule(5000); } });
    var x0 = null, y0 = 0;
    slider.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    slider.addEventListener("touchend", function (e) {
      if (x0 === null) return; var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(idx + (dx < 0 ? 1 : -1));
    });
    slides.forEach(function (s) {
      var pt = $(".portrait", s); if (!pt) return;
      pt.addEventListener("pointermove", function (e) { if (still()) return; var r = pt.getBoundingClientRect(); pt.style.setProperty("--rx", ((e.clientX - r.left) / r.width - .5) * 16 + "deg"); pt.style.setProperty("--ry", -((e.clientY - r.top) / r.height - .5) * 16 + "deg"); });
      pt.addEventListener("pointerleave", function () { pt.style.setProperty("--rx", "0deg"); pt.style.setProperty("--ry", "0deg"); });
    });
    slides.forEach(function (s, k) { if (k) { s.setAttribute("aria-hidden", "true"); if ("inert" in s) s.inert = true; } });
    onView(slider, function (v) {
      var was = inView; inView = v;
      if (v && !was) type();
      if (!v) { stopAdvance(); stopTyping(); }
    }, { threshold: .35 });
    onMotion(function () { if (still()) { stopAdvance(); stopTyping(); live.setAttribute("aria-live", "polite"); } else schedule(3000); });
  });

  /* ---------- Workflow animé ---------- */
  mod("workflow", function () {
    var flow = $("#flow"), detail = $("#flowDetail"), path = $("#flowPath"), glow = $("#flowGlow"); if (!flow || !detail || !path || !glow) return;
    var items = $$("#flowSteps li"), svg = $(".flow-line", flow), cyc = $$(".cycle-steps li");
    var cur = -1, timer = 0, inView = false, hover = false, userHold = 0, total = 0, stops = [];
    function geometry() {
      if (!svg || getComputedStyle(svg).display === "none") { total = 0; return; }
      var fr = flow.getBoundingClientRect(); svg.setAttribute("viewBox", "0 0 " + fr.width + " " + fr.height);
      var pts = items.map(function (li) { var im = $("img, .you-dot", li).getBoundingClientRect(); return [im.left - fr.left + im.width / 2, im.top - fr.top + im.height / 2]; });
      var segs = ["M" + pts[0][0] + " " + pts[0][1]];
      for (var i = 1; i < pts.length; i++) segs.push(" L" + pts[i][0] + " " + pts[i][1]);
      var d = segs.join("");
      path.setAttribute("d", d); glow.setAttribute("d", d);
      total = glow.getTotalLength(); glow.style.strokeDasharray = String(total);
      // segments droits : la longueur jusqu'à chaque étape est la somme des distances
      stops = [0];
      for (var k = 1; k < pts.length; k++) stops.push(stops[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      paintLine();
    }
    function paintLine() { if (total) glow.style.strokeDashoffset = String(cur < 0 ? total : total - stops[cur]); }
    function set(i, fromUser) {
      cur = i;
      items.forEach(function (li, k) { li.classList.toggle("active", k === i); li.classList.toggle("done", k < i); $("button", li).setAttribute("aria-pressed", k === i ? "true" : "false"); });
      cyc.forEach(function (c, k) { c.classList.toggle("lit", k <= i); });
      var li = items[i], img = $("img", li);
      // annonce aux lecteurs d'écran seulement quand le visiteur choisit l'étape (pas pendant le défilement automatique)
      detail.setAttribute("aria-live", fromUser ? "polite" : "off");
      var w = doc.createElement("div"); w.className = "fd";
      var av;
      if (img) { av = img.cloneNode(); av.alt = ""; } else { av = doc.createElement("span"); av.className = "you-dot"; av.setAttribute("aria-hidden", "true"); av.textContent = "✓"; }
      var p = doc.createElement("p"), b = doc.createElement("b");
      b.textContent = (i + 1) + ". " + $("b", li).textContent + " · " + $("small", li).textContent + " — ";
      p.appendChild(b); p.appendChild(doc.createTextNode($("p", li).textContent));
      w.appendChild(av); w.appendChild(p);
      detail.replaceChildren(w);
      paintLine();
    }
    function tick() {
      clearTimeout(timer);
      if (!inView || hover || still()) return;
      var wait = cur === items.length - 1 ? 3800 : Date.now() < userHold ? 9000 : 2100;
      timer = setTimeout(function () { set(cur >= items.length - 1 ? 0 : cur + 1, false); tick(); }, wait);
    }
    items.forEach(function (li, k) { $("button", li).addEventListener("click", function () { userHold = Date.now() + 8000; set(k, true); tick(); }); });
    flow.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") { hover = true; clearTimeout(timer); } });
    flow.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") { hover = false; tick(); } });
    flow.addEventListener("focusin", function () { hover = true; clearTimeout(timer); });
    flow.addEventListener("focusout", function (e) { if (!flow.contains(e.relatedTarget)) { hover = false; tick(); } });
    new ResizeObserver(geometry).observe(flow);
    set(0, false);
    onView(flow, function (v) { inView = v; if (v) { geometry(); tick(); } else clearTimeout(timer); }, { threshold: .3 });
    onMotion(tick);
  });

  /* ---------- Aperçu : onglets, rotation et perspective ---------- */
  mod("aperçu", function () {
    var tabs = $$("#shotTabs button"), stage = $("#stage"); if (!stage || !tabs.length) return;
    var lap = $$(".laptop .screens img", stage), ph = $$(".phone .screens img", stage), cur = 0, timer = 0, user = false, vis = false, hover = false;
    function show(i, focus) {
      cur = i;
      tabs.forEach(function (t, k) { t.setAttribute("aria-selected", k === i ? "true" : "false"); t.tabIndex = k === i ? 0 : -1; });
      stage.setAttribute("aria-labelledby", tabs[i].id);
      [lap, ph].forEach(function (list) { list.forEach(function (im, k) { im.classList.toggle("is-on", k === i); im.setAttribute("aria-hidden", k === i ? "false" : "true"); }); });
      if (focus) tabs[i].focus();
    }
    function auto() { clearTimeout(timer); if (user || !vis || hover || still()) return; timer = setTimeout(function () { show((cur + 1) % tabs.length); auto(); }, 4800); }
    tabs.forEach(function (t, k) {
      t.addEventListener("click", function () { user = true; clearTimeout(timer); show(k); });
      t.addEventListener("keydown", function (e) {
        var n = { ArrowRight: cur + 1, ArrowLeft: cur - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (n === undefined) return; e.preventDefault(); user = true; clearTimeout(timer); show((n + tabs.length) % tabs.length, true);
      });
    });
    stage.addEventListener("pointerenter", function () { hover = true; clearTimeout(timer); });
    stage.addEventListener("pointerleave", function () { hover = false; auto(); });
    show(0);
    onView(stage, function (v) { vis = v; auto(); }, { threshold: .3 });
    onMotion(auto);
    var lapEl = $(".laptop", stage), phone = $(".phone", stage), ticking = false, near = false;
    onView(stage, function (v) { near = v; }, { threshold: 0, rootMargin: "200px 0px" });
    function par() {
      ticking = false;
      if (still() || !near || !lapEl || !phone) return;
      var r = stage.getBoundingClientRect(), vh = window.innerHeight, p = Math.max(0, Math.min(1, (vh - r.top) / (vh * .9)));
      lapEl.style.setProperty("--tilt", (14 * (1 - p)).toFixed(2) + "deg");
      phone.style.setProperty("--py", (40 * (1 - p) - 10).toFixed(1) + "px");
    }
    window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(par); } }, { passive: true });
    par();
  });

  /* ---------- Veto ---------- */
  mod("veto", function () {
    var veto = $("#vetoCard"); if (!veto) return;
    onView(veto, function (v) { if (v) veto.classList.add("stamped"); }, { threshold: .6 });
  });

  // Les apparitions ne restent actives que si tout s'est bien initialisé ; sinon le contenu s'affiche tel quel.
  if (failed) root.classList.remove("js"); else window.__nsReady = true;
})();
