/* ============================================================
   Aseos de Madrid — localizador de aseos y servicios
   Datos: Ayuntamiento de Madrid (CC BY 4.0) + OpenStreetMap (ODbL)
   Adaptado a partir de "Fuentes de Madrid" (mismo autor).
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const APP_VERSION = '1.0.7';
const FAV_KEY = 'aseos_favs_v1';
const TARGET_KEY = 'aseos_target_v1';
const SHEET_OPEN_KEY = 'aseos_sheet_open_v1';
const VISITS_KEY = 'aseos_visits_v1';
const LAST_ACTIVE_KEY = 'aseos_last_active_v1';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;   // más de esto sin usarla = sesión nueva: sin selección ni vista previas
const VIEW_KEY = 'aseos_view_v1';
const FILTERS_KEY = 'aseos_filters_v1';
const DEV_UNLOCKED_KEY = 'aseos_dev_unlocked_v1';
const DEV_FAKELOC_KEY = 'aseos_dev_fakeloc_v1';
const CLUSTER_KEY = 'aseos_cluster_v1';
const CLUSTER_DEFAULTS = { disableClusteringAtZoom: 14, maxClusterRadius: 60 };
const INFO_URL = 'https://datos.madrid.es/dataset/300103-0-aseos-publicos-operativos';
const MIN_RADIUS = 70;           // m: evita sobre-acercar si el servicio está pegado
const HEADING_SMOOTH = 0.16;     // suavizado de la brújula en AR (más bajo = más lento pero ignora saltos)
const HEADING_JUMP = 100;        // grados: cambio brusco = ruido del sensor → lo amortiguamos
const TRAIL_MIN_DIST = 14;       // m entre puntos de la estela: separados, como un rastro de peli, no un churro
const MAP_HEADING_SMOOTH = 0.045; // suavizado del modo brújula del mapa: prioriza calma sobre precisión
const MAP_BEARING_THROTTLE = 200; // ms mínimos entre giros del mapa en modo brújula (evita trabajo de más)
const OUTSIDE_MADRID_KM = 20;     // si lo más cercano está más lejos que esto, probablemente no estás en Madrid
const MADRID_SOL = { lat: 40.4168, lon: -3.7038 };

/* ---------- Categorías ---------- */
const TIPO_LABEL = {
  aseo_oficial: 'Aseo público', aseo_comunidad: 'Aseo (comunidad)',
  bar: 'Bar', cafeteria: 'Cafetería', fastfood: 'Comida rápida',
  centro_comercial: 'Centro comercial', estacion: 'Estación'
};
const TIPO_EMOJI = {
  aseo_oficial: '🚻', aseo_comunidad: '🚻', bar: '🍺', cafeteria: '☕', fastfood: '🍔',
  centro_comercial: '🛍️', estacion: '🚉'
};
/* aseo_oficial/aseo_comunidad siguen el color de acento elegido en ajustes
   (como las fuentes); el resto de categorías llevan un color fijo propio,
   para distinguirlas de un vistazo como "candidatas", no "aseo confirmado". */
const TIPO_COLOR_FIJO = { bar: '#F2A007', cafeteria: '#8B5A32', fastfood: '#E94378', centro_comercial: '#12b886', estacion: '#7048e8' };
const PAGO_LABEL = { gratis: 'Gratis', pago: 'De pago', consumicion: 'Con consumición', desconocido: 'Pago desconocido' };
const EMERGENCY_TIPOS = new Set(['bar', 'cafeteria', 'fastfood', 'centro_comercial']);
function tipoLabel(t) { return TIPO_LABEL[t] || t; }

/* ---------- Panel de urgencia: minutos al aseo gratis más cercano ----------
   Escala pedida explícitamente: <5 min tranquilo, <=10 ojo, <=20 precaución,
   más de eso, alerta roja (el hueco entre "20" y "los 30 min" que se
   mencionó como ejemplo lo resolvemos metiendo el corte en 20: a partir de
   ahí ya es la categoría más grave, "30" queda como caso extremo dentro de
   esa misma categoría, no como un quinto nivel). */
const URGENCY_LEVELS = [
  { key: 'ok', max: 5, icon: '🟢', labelKey: 'urgency_ok' },
  { key: 'warn', max: 10, icon: '🟡', labelKey: 'urgency_warn' },
  { key: 'caution', max: 20, icon: '🟠', labelKey: 'urgency_caution' },
  { key: 'danger', max: Infinity, icon: '🔴', labelKey: 'urgency_danger' },
];
function urgencyLevelFor(min) {
  if (min == null) return URGENCY_LEVELS[URGENCY_LEVELS.length - 1];
  return URGENCY_LEVELS.find(l => min <= l.max) || URGENCY_LEVELS[URGENCY_LEVELS.length - 1];
}

/* ---------- State ---------- */
let map, userMarker, accCircle, placeCluster, selectedMarker;
let allPlaces = [];       // todo lo cargado del JSON
let corePlaces = [];      // aseo_oficial + aseo_comunidad + estacion (para el aviso de "fuera de Madrid", barato de recorrer)
let places = [];          // tras aplicar filtros, ordenado por cercanía
let userPos = null;
let geoWatchId = null;
let selected = null;
let dataUpdated = Date.now();
const filters = {
  favOnly: false, emergency: false,
  emergencyCats: { bar: true, cafeteria: true, fastfood: true, centro_comercial: true }
};
try {
  const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}');
  Object.assign(filters, saved);
  if (saved.emergencyCats) Object.assign(filters.emergencyCats, saved.emergencyCats);
} catch (_) {}
function saveFilters() { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (_) {} }

/* favoritos (persisten en el navegador) */
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch (_) {}
function favKey(p) { return p.id; }
function isFav(p) { return favs.has(favKey(p)); }
function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch (_) {} }
function toggleFav(p) {
  const k = favKey(p);
  if (favs.has(k)) favs.delete(k); else favs.add(k);
  saveFavs();
  return favs.has(k);
}

/* lugares visitados: nº de veces + fecha de la última, guardado en el móvil */
const VISIT_RADIUS_M = 15;             // hay que estar a menos de esto para que cuente como visita
const VISIT_COOLDOWN_MS = 30 * 60 * 1000;   // no cuentes otra visita si sigues junto al mismo lugar
let visits = {};
try { visits = JSON.parse(localStorage.getItem(VISITS_KEY) || '{}'); } catch (_) {}
function saveVisits() { try { localStorage.setItem(VISITS_KEY, JSON.stringify(visits)); } catch (_) {} }
function checkVisits() {
  const now = Date.now();
  let changed = false;
  for (const p of places) {   // `places` va ordenado por cercanía: en cuanto nos pasamos del radio, ya no hay más
    if (p.dist == null || p.dist > VISIT_RADIUS_M) break;
    const key = favKey(p);
    const v = visits[key];
    if (!v || (now - v.last) > VISIT_COOLDOWN_MS) {
      visits[key] = { count: (v ? v.count : 0) + 1, last: now };
      changed = true;
    }
  }
  if (changed) {
    saveVisits();
    if (selected && $('sheet').classList.contains('open')) renderVisitInfo(selected);
  }
}

/* ============================================================
   AJUSTES (tema, tema de mapa, import/export) — persistentes
   ============================================================ */
const SETTINGS_KEY = 'aseos_settings_v1';
let settings = { theme: 'system', map: 'moderno', accent: 'blue', trailOn: true, trailLen: 5, lang: 'auto' };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }

/* Ajuste de clústering: expuesto en modo desarrollador para comparar en vivo
   qué zoom/radio se sienten mejor, sin tener que republicar la app cada vez. */
let clusterSettings = Object.assign({}, CLUSTER_DEFAULTS);
try { Object.assign(clusterSettings, JSON.parse(localStorage.getItem(CLUSTER_KEY) || '{}')); } catch (_) {}
function saveClusterSettings() { try { localStorage.setItem(CLUSTER_KEY, JSON.stringify(clusterSettings)); } catch (_) {} }

/* ============================================================
   IDIOMA — por ahora solo español; el mecanismo queda listo para
   añadir más languages/<código>.json más adelante sin tocar el código.
   ============================================================ */
let I18N = {};
let LANG_META = {};   // código -> { name: 'Español' }
async function loadLanguages() {
  try {
    const manifest = await fetch('languages/manifest.json', { cache: 'no-cache' }).then(r => r.json());
    const codes = Array.isArray(manifest.available) ? manifest.available : [];
    await Promise.all(codes.map(async (code) => {
      try {
        const data = await fetch(`languages/${code}.json`, { cache: 'no-cache' }).then(r => r.json());
        if (data && data.strings) { I18N[code] = data.strings; LANG_META[code] = data.meta || { name: code }; }
      } catch (_) { /* ese idioma en concreto no cargó (o aún no existe): seguimos con los demás */ }
    }));
  } catch (_) { /* sin manifiesto (sin red la primera vez, etc.): nos quedamos con el texto estático del HTML */ }
}
function getLang() {
  if (settings.lang && settings.lang !== 'auto' && I18N[settings.lang]) return settings.lang;
  const nav = (navigator.language || 'es').toLowerCase().slice(0, 2);
  if (I18N[nav]) return nav;
  return I18N.es ? 'es' : (Object.keys(I18N)[0] || 'es');
}
function t(k) { const L = getLang(); return (I18N[L] && I18N[L][k]) || (I18N.es && I18N.es[k]) || k; }
const RTL_LANGS = ['ar'];
function applyI18n() {
  const L = getLang();
  if (!I18N[L]) return;   // aún no ha cargado ningún idioma: se queda el texto estático del HTML
  document.documentElement.setAttribute('lang', L);
  document.documentElement.dir = RTL_LANGS.includes(L) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (I18N[L][k] != null) { if (/[<&]/.test(I18N[L][k])) el.innerHTML = I18N[L][k]; else el.textContent = I18N[L][k]; }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (I18N[L][k] != null) el.title = I18N[L][k];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (I18N[L][k] != null) el.placeholder = I18N[L][k];
  });
}

const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> &middot; ' +
               '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> &middot; ' +
               '<a href="' + INFO_URL + '" target="_blank" rel="noopener">Ayto. de Madrid</a>';
/* TILES, MAP_THEMES y ACCENTS viven en themes.js (cargado antes que app.js) */
let tileLayer = null;
let ACCENT = '#1f7fe0', ACCENT_L = '#3ea8ff';

function isDark() {
  const th = settings.theme;
  return th === 'dark' || (th === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', ACCENT);
  applyMapTheme();
}
function applyMapTheme() {
  if (!map) return;
  const theme = MAP_THEMES[settings.map] || MAP_THEMES.moderno;
  const cfg = isDark() ? theme.dark : theme.light;
  const tile = TILES[cfg.t] || TILES.voyager;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(tile.url, {
    attribution: ATTRIB, subdomains: tile.sub, maxZoom: 20, detectRetina: true,
    keepBuffer: 6
  });
  tileLayer.addTo(map); tileLayer.setZIndex(0);
  const el = tileLayer.getContainer && tileLayer.getContainer();
  if (el) el.style.filter = cfg.f || '';
  prefetchedTiles.clear();
}

/* ============================================================
   PRECACHE de teselas (igual que en Fuentes de Madrid)
   ============================================================ */
const PREFETCH_RING = 5;
const PREFETCH_MAX_KEYS = 2000;
const prefetchedTiles = new Set();
function prefetchTileRing() {
  if (!map || !tileLayer || mapMode === 'compass') return;
  const z = Math.round(map.getZoom());
  const bounds = map.getBounds();
  const nw = map.project(bounds.getNorthWest(), z).divideBy(256).floor();
  const se = map.project(bounds.getSouthEast(), z).divideBy(256).floor();
  const maxTile = Math.pow(2, z);
  if (prefetchedTiles.size > PREFETCH_MAX_KEYS) prefetchedTiles.clear();
  for (let x = nw.x - PREFETCH_RING; x <= se.x + PREFETCH_RING; x++) {
    if (x < 0 || x >= maxTile) continue;
    for (let y = nw.y - PREFETCH_RING; y <= se.y + PREFETCH_RING; y++) {
      if (y < 0 || y >= maxTile) continue;
      const key = `${z}/${x}/${y}`;
      if (prefetchedTiles.has(key)) continue;
      prefetchedTiles.add(key);
      new Image().src = tileLayer.getTileUrl({ x, y, z });
    }
  }
}
function applyAccent() {
  const a = ACCENTS[settings.accent] || ACCENTS.blue;
  ACCENT = a.main; ACCENT_L = a.l;
  const s = document.documentElement.style;
  s.setProperty('--blue', a.main); s.setProperty('--blue-d', a.d); s.setProperty('--blue-l', a.l);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', a.main);
  if (map) { refreshAllIcons(); renderTrail(); }
}

/* ---- Estela de ubicación (rastro de puntos que se difuminan) ---- */
let trail = [];
let trailLayer = null;
let trailTimer = null;
let lastTrailPos = null;
function trailMax() { return Math.max(3, Math.min(10, parseInt(settings.trailLen, 10) || 5)); }
function clearTrailLayer() { trail = []; lastTrailPos = null; if (trailLayer) trailLayer.clearLayers(); }
function startTrail() {
  if (!map) return;
  if (!trailLayer) trailLayer = L.layerGroup().addTo(map);
  if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
  if (!settings.trailOn) { clearTrailLayer(); return; }
  trailTimer = setInterval(sampleTrail, 4000);
}
function sampleTrail() {
  if (!settings.trailOn || !userPos || !map) return;
  if (lastTrailPos && haversine(lastTrailPos.lat, lastTrailPos.lon, userPos.lat, userPos.lon) < TRAIL_MIN_DIST) return;
  trail.unshift({ lat: userPos.lat, lon: userPos.lon });
  lastTrailPos = { lat: userPos.lat, lon: userPos.lon };
  if (trail.length > trailMax()) trail.length = trailMax();
  renderTrail();
}
function renderTrail() {
  if (!trailLayer) return;
  trailLayer.clearLayers();
  if (!settings.trailOn) return;
  const n = trail.length;
  for (let i = 0; i < n; i++) {
    const op = 1 - i / (n + 0.6);
    L.circleMarker([trail[i].lat, trail[i].lon], {
      radius: 5, color: '#fff', weight: 1.4, opacity: op * 0.9, fillColor: ACCENT, fillOpacity: op
    }).addTo(trailLayer);
  }
}

try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); }); } catch (_) {}

function exportData() {
  const data = {
    v: 2, favs: [...favs], settings: settings, visits: visits,
    target: (function () { try { return localStorage.getItem(TARGET_KEY) || ''; } catch (_) { return ''; } })()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'aseos-madrid-config.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(t('exported'));
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (Array.isArray(d.favs)) { favs = new Set(d.favs); saveFavs(); }
      if (d.settings && typeof d.settings === 'object') { settings = Object.assign(settings, d.settings); saveSettings(); applyTheme(); applyMapTheme(); }
      if (d.visits && typeof d.visits === 'object') { visits = d.visits; saveVisits(); }
      if (typeof d.target === 'string') { try { localStorage.setItem(TARGET_KEY, d.target); } catch (_) {} }
      if (map) { refreshAllIcons(); applyFilters(); rebuildMarkers(); }
      syncSettingsUI();
      toast(t('imported'));
    } catch (e) { toast(t('bad_file')); }
  };
  r.readAsText(file);
}
function populateOtherLanguages() {
  const sel = $('setLangOther'); if (!sel) return;
  const others = Object.keys(I18N).filter(c => c !== 'es' && c !== 'en').sort();
  sel.innerHTML = '<option value="" disabled></option>' +
    others.map(c => `<option value="${c}">${(LANG_META[c] && LANG_META[c].name) || c}</option>`).join('');
}
let otherPickerOpen = false;
function syncSettingsUI() {
  const st = $('setTheme'), sm = $('setMap'), sa = $('setAccent'), sl = $('setLang'), slOther = $('setLangOther');
  if (st) st.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.theme === settings.theme));
  if (sm) sm.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.map === settings.map));
  if (sa) sa.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.accent === settings.accent));
  if (sl) {
    const resolved = getLang();
    const isOtherActive = resolved !== 'es' && resolved !== 'en';
    const group = isOtherActive || otherPickerOpen ? 'other' : resolved;
    sl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.lang === group));
    if (slOther) {
      const ph = slOther.querySelector('option[value=""]');
      if (ph) ph.textContent = t('lang_placeholder');
      slOther.style.display = group === 'other' ? 'block' : 'none';
      if (group === 'other') slOther.value = isOtherActive ? resolved : '';
    }
  }
  if ($('fTrail')) $('fTrail').checked = !!settings.trailOn;
  if ($('fTrailLen')) $('fTrailLen').value = trailMax();
  if ($('trailLenVal')) $('trailLenVal').textContent = trailMax();
  if ($('trailLenRow')) $('trailLenRow').style.display = settings.trailOn ? '' : 'none';
}

applyI18n();
applyAccent();
applyTheme();

/* orientación del mapa */
let mapMode = 'north';
let programmaticBearing = false;
let mapHeading = null;
let lastMapBearingUpdate = 0;
let lastTileRefresh = 0;
let headingConeEl = null;

/* AR */
let arHeading = null;
let arPitch = null;
let arArrivedVibrated = false;

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(aLat, aLon, bLat, bLon) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
            Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function smoothAngle(cur, target, alpha) {
  if (cur == null) return target;
  let d = ((target - cur + 540) % 360) - 180;
  return (cur + alpha * d + 360) % 360;
}
function fmtDist(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function minutesWalk(m) { return m == null ? null : Math.round(m / 80); }
function fmtWalkMin(m) {
  if (m == null) return '';
  const min = minutesWalk(m);
  return min < 1 ? '<1 min' : `${min} min`;
}
function debounce(fn, ms) { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; }

let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('toast'); el.innerHTML = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ============================================================
   HORARIOS: ¿probablemente abierto ahora?
   ============================================================ */
function parseTimeRanges(detalle) {
  if (!detalle) return [];
  return detalle.split(',').map(s => s.trim()).map(seg => {
    const m = seg.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const start = (+m[1]) * 60 + (+m[2]);
    let end = (+m[3]) * 60 + (+m[4]);
    if (end <= start) end += 1440;   // cruza medianoche
    return [start, end];
  }).filter(Boolean);
}
/* true = probablemente abierto, false = probablemente cerrado, null = no se sabe */
function isLikelyOpenNow(p) {
  const h = p.horario;
  if (!h) return null;
  if (h.modo === '24h') return true;
  if (h.modo === 'desconocido' || !h.detalle) return null;
  const ranges = parseTimeRanges(h.detalle);
  if (!ranges.length) return null;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const [s, e] of ranges) {
    if (mins >= s && mins <= e) return true;
    if (mins + 1440 >= s && mins + 1440 <= e) return true;
  }
  return false;
}
function horarioChip(p) {
  const h = p.horario;
  if (h && h.modo === '24h') return `<span class="chip ok">${checkSvg()} ${t('open_24h')}</span>`;
  const open = isLikelyOpenNow(p);
  if (open === true) return `<span class="chip ok">${checkSvg()} ${t('open_now')}</span>`;
  if (open === false) return `<span class="chip bad">${crossSvg()} ${t('closed_now')}</span>`;
  return '';
}

/* ============================================================
   DATA: data/aseos.json
   ============================================================ */
let _dataPromise = null;
function ensureData() {
  if (allPlaces.length) return Promise.resolve(allPlaces);
  if (!_dataPromise) _dataPromise = loadData().catch((e) => { _dataPromise = null; throw e; });
  return _dataPromise;
}
async function loadData() {
  const res = await fetch('./data/aseos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const list = (data.lugares || []).filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
  if (!list.length) throw new Error('Sin datos');
  allPlaces = list.map(makePlace);
  corePlaces = allPlaces.filter(p => !EMERGENCY_TIPOS.has(p.tipo));
  dataUpdated = data.generado || Date.now();
  setUpdated(dataUpdated, allPlaces.length);
  return allPlaces;
}
function makePlace(p) { return Object.assign({}, p, { marker: null, dist: null }); }

let _statusState = null;
function setUpdated(ms, n) {
  _statusState = { error: false, ms, n };
  renderStatus();
}
function setUpdatedError() {
  _statusState = { error: true };
  renderStatus();
}
function renderStatus() {
  if (!_statusState || !$('updatedText')) return;
  if (_statusState.error) { $('updatedText').textContent = t('db_error'); return; }
  const d = new Date(_statusState.ms);
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: '2-digit' });
  $('updatedText').textContent = `${t('data_updated')}: ${fmt} · ${_statusState.n} ${t('f_fountains')}`;
}

/* ============================================================
   ARRANQUE: salta la splash si ya hay permiso de ubicación
   ============================================================ */
function fakeLocationFromUrl() {
  const m = location.search.match(/[?&]fakeloc=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon, acc: 20 };
}
function fakeLocationFromDev() {
  try {
    const d = JSON.parse(localStorage.getItem(DEV_FAKELOC_KEY) || 'null');
    if (d && isFinite(d.lat) && isFinite(d.lon)) return { lat: d.lat, lon: d.lon, acc: 20 };
  } catch (_) {}
  return null;
}
function getFakeLocation() { return fakeLocationFromUrl() || fakeLocationFromDev(); }
async function autoStartIfAllowed() {
  const fake = getFakeLocation();
  if (fake) { userPos = fake; startApp(); return; }
  let granted = false;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      granted = st.state === 'granted';
    }
  } catch (_) {}

  if (!granted) { $('loading').style.display = 'none'; $('splash').style.display = 'flex'; return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => { userPos = posToObj(pos); startApp(); },
    () => { $('loading').style.display = 'none'; $('splash').style.display = 'flex'; },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

$('askLocation').addEventListener('click', requestLocation);
function requestLocation() {
  const fake = getFakeLocation();
  if (fake) { userPos = fake; startApp(); return; }
  if (!('geolocation' in navigator)) { $('splashErr').textContent = t('no_geo'); return; }
  const btn = $('askLocation');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${t('searching')}`;
  $('splashErr').textContent = '';
  navigator.geolocation.getCurrentPosition(
    (pos) => { userPos = posToObj(pos); startApp(); },
    (err) => {
      btn.disabled = false;
      btn.textContent = t('btn_allow');
      $('splashErr').textContent = err.code === 1 ? t('err_denied') : t('err_locate');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}
function posToObj(pos) { return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }; }

/* ---------- ¿sesión nueva o "seguimos donde lo dejamos"? ---------- */
function isFreshSession() {
  let last = null;
  try { last = parseInt(localStorage.getItem(LAST_ACTIVE_KEY), 10); } catch (_) {}
  if (!last || isNaN(last)) return true;
  return (Date.now() - last) > SESSION_TIMEOUT_MS;
}
function markActive() { try { localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); } catch (_) {} }
document.addEventListener('visibilitychange', () => { if (document.hidden) markActive(); });
window.addEventListener('pagehide', markActive);
setInterval(() => { if (!document.hidden) markActive(); }, 60000);
let freshSession = true;

async function startApp() {
  freshSession = isFreshSession();
  try { if (!allPlaces.length) await ensureData(); }
  catch (e) {
    $('loading').style.display = 'none';
    $('splash').style.display = 'flex';
    $('askLocation').disabled = false;
    $('askLocation').textContent = t('retry');
    $('splashErr').textContent = t('err_load');
    return;
  }
  $('loading').style.display = 'none';
  $('splash').style.display = 'none';
  $('app').style.display = 'flex';
  initMap();
  watchPosition();
  checkOutsideMadrid();
}

/* ---------- Aviso "fuera de Madrid" ---------- */
function nearestDistanceKm(lat, lon) {
  let best = Infinity;
  for (const p of corePlaces) { const d = haversine(lat, lon, p.lat, p.lon); if (d < best) best = d; }
  return best / 1000;
}
function checkOutsideMadrid() {
  if (!userPos || !corePlaces.length) return;
  if (nearestDistanceKm(userPos.lat, userPos.lon) > OUTSIDE_MADRID_KM) $('outsideModal').style.display = 'flex';
}

/* ---------- Panel de urgencia ---------- */
/* Recorre TODO allPlaces (no el `places` filtrado): el aviso debe reflejar la
   realidad aunque el usuario tenga desactivados los servicios de emergencia. */
function nearestByPago(pagoSet) {
  if (!userPos) return null;
  let best = Infinity;
  for (const p of allPlaces) {
    if (!pagoSet.has(p.pago)) continue;
    const d = haversine(userPos.lat, userPos.lon, p.lat, p.lon);
    if (d < best) best = d;
  }
  return isFinite(best) ? best : null;
}
const PAGO_GRATIS = new Set(['gratis']);
const PAGO_ALTERNATIVA = new Set(['pago', 'consumicion']);
function updateUrgencyPanel() {
  const panel = $('urgencyPanel');
  if (!panel || !userPos || !allPlaces.length) return;
  const freeMin = minutesWalk(nearestByPago(PAGO_GRATIS));
  const altMin = minutesWalk(nearestByPago(PAGO_ALTERNATIVA));
  const level = urgencyLevelFor(freeMin);

  panel.className = 'level-' + level.key;
  $('urgencyIcon').textContent = level.icon;
  $('urgencyLabel').textContent = t(level.labelKey);
  $('urgencyDetail').textContent = freeMin == null
    ? t('urgency_nodata')
    : t('urgency_detail').replace('{min}', freeMin);

  const altEl = $('urgencyAlt');
  if (altMin != null && freeMin != null && altMin < freeMin) {
    altEl.textContent = t('urgency_alt').replace('{min}', altMin);
    altEl.style.display = '';
  } else {
    altEl.style.display = 'none';
  }
  panel.style.display = 'flex';
}
$('teleportBtn').addEventListener('click', () => {
  userPos = { lat: MADRID_SOL.lat, lon: MADRID_SOL.lon, acc: 20 };
  $('outsideModal').style.display = 'none';
  if (userMarker) userMarker.setLatLng([userPos.lat, userPos.lon]);
  if (accCircle) { accCircle.setLatLng([userPos.lat, userPos.lon]); accCircle.setRadius(userPos.acc); }
  lastRecomputePos = null;
  recomputeDistances();
  updateUrgencyPanel();
  if (radarOpen) refreshRadar();
  fitInitialView();
});
$('outsideDismiss').addEventListener('click', () => {
  $('outsideModal').style.display = 'none';
  if (map) map.setView([MADRID_SOL.lat, MADRID_SOL.lon], 13, { animate: false });
});

/* ---------- Panel "Acerca de" (al tocar el título) ---------- */
$('aboutBtn').addEventListener('click', () => { closeSheet(); $('about').classList.add('open'); checkForUpdate(); });
$('aboutClose').addEventListener('click', () => $('about').classList.remove('open'));

/* ============================================================
   FILTERS
   ============================================================ */
function matchesFilter(p) {
  if (filters.favOnly && !isFav(p)) return false;
  if (EMERGENCY_TIPOS.has(p.tipo)) {
    if (!filters.emergency) return false;
    if (filters.emergencyCats[p.tipo] === false) return false;
  }
  return true;
}
function applyFilters() {
  places = allPlaces.filter(matchesFilter);
  recomputeDistances();
  if ($('countN')) $('countN').textContent = `${places.length}`;
  if ($('emptyState')) $('emptyState').style.display = places.length ? 'none' : 'flex';
}
if ($('emptyClearBtn')) $('emptyClearBtn').addEventListener('click', () => {
  filters.favOnly = false; filters.emergency = false;
  filters.emergencyCats = { bar: true, cafeteria: true, fastfood: true, centro_comercial: true };
  saveFilters(); applyFilters(); rebuildMarkers(); fitInitialView();
});
function readFilterUI() {
  filters.favOnly = $('fFav').checked;
  filters.emergency = $('fEmergency').checked;
  filters.emergencyCats.bar = $('catBar').checked;
  filters.emergencyCats.cafeteria = $('catCafeteria').checked;
  filters.emergencyCats.fastfood = $('catFastfood').checked;
  filters.emergencyCats.centro_comercial = $('catCC').checked;
  saveFilters();
}
function updateEmergencyCatsUI() {
  $('emergencyCats').style.display = $('fEmergency').checked ? 'flex' : 'none';
}
function onFilterChange() {
  readFilterUI(); updateEmergencyCatsUI(); applyFilters(); rebuildMarkers(); renderListItems();
  if (radarOpen) refreshRadar();
}

/* ============================================================
   LIST (servicios cercanos, ordenados por distancia)
   ============================================================ */
const LIST_CAP = 200;
function rowIcon(p) { return isFav(p) ? '❤️' : (TIPO_EMOJI[p.tipo] || '📍'); }
function normalizeSearch(s) { return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(); }
let listQuery = '';
function renderListItems() {
  const wrap = $('listItems');
  const q = normalizeSearch(listQuery);
  const list = q
    ? places.filter(p => normalizeSearch([p.nombre, p.direccion, p.agrupacion && p.agrupacion.nombre].join(' ')).includes(q))
    : places;
  if (!list.length) { wrap.innerHTML = `<p class="list-empty">${t('list_empty')}</p>`; return; }
  wrap.innerHTML = list.slice(0, LIST_CAP).map((p) => {
    const label = p.nombre || p.direccion || tipoLabel(p.tipo);
    return `<button class="list-row" data-k="${favKey(p)}">
      <span class="list-ico">${rowIcon(p)}</span>
      <span class="list-txt"><span class="list-name">${label}</span></span>
      <span class="list-dist">${fmtDist(p.dist)}</span>
    </button>`;
  }).join('');
}
function setFiltersRowOpen(open) {
  $('filtersRow').style.display = open ? 'flex' : 'none';
  $('filtersToggleBtn').setAttribute('aria-expanded', String(open));
}
function openServicesSheet() {
  closeSheet();
  $('fFav').checked = filters.favOnly;
  $('fEmergency').checked = filters.emergency;
  $('catBar').checked = filters.emergencyCats.bar;
  $('catCafeteria').checked = filters.emergencyCats.cafeteria;
  $('catFastfood').checked = filters.emergencyCats.fastfood;
  $('catCC').checked = filters.emergencyCats.centro_comercial;
  setFiltersRowOpen(false);
  updateEmergencyCatsUI();
  $('listSheet').classList.remove('maximized');
  listQuery = '';
  if ($('listSearch')) $('listSearch').value = '';
  renderListItems();
  $('listSheet').classList.add('open');
  $('listItems').scrollTop = 0;
}
function closeServicesSheet(refit) {
  $('listSheet').classList.remove('open');
  if (refit !== false) fitInitialView();
}
function toggleServicesSheet() { if ($('listSheet').classList.contains('open')) closeServicesSheet(); else openServicesSheet(); }
$('count').addEventListener('click', toggleServicesSheet);
$('listClose').addEventListener('click', closeServicesSheet);
$('filtersToggleBtn').addEventListener('click', () => {
  setFiltersRowOpen($('filtersRow').style.display === 'none');
});
$('listItems').addEventListener('scroll', () => {
  if ($('listItems').scrollTop > 4) $('listSheet').classList.add('maximized');
}, { passive: true });
if ($('listSearch')) $('listSearch').addEventListener('input', () => { listQuery = $('listSearch').value; renderListItems(); });
$('listItems').addEventListener('click', (e) => {
  const btn = e.target.closest('.list-row'); if (!btn) return;
  const p = places.find(x => favKey(x) === btn.dataset.k);
  if (!p) return;
  closeServicesSheet(false);
  map.setView([p.lat, p.lon], 17, { animate: true });
  openSheet(p);
});

/* ============================================================
   MAP
   ============================================================ */
function userIcon() {
  return L.divIcon({
    className: '', iconSize: [130, 130], iconAnchor: [65, 65],
    html: `<div class="user-dot-wrap">
      <div class="heading-cone">
        <svg width="130" height="130" viewBox="0 0 130 130">
          <defs>
            <linearGradient id="coneGrad" x1="65" y1="65" x2="65" y2="5" gradientUnits="userSpaceOnUse">
              <stop offset="0%" style="stop-color:var(--blue);stop-opacity:.5"/>
              <stop offset="100%" style="stop-color:var(--blue);stop-opacity:0"/>
            </linearGradient>
          </defs>
          <path d="M65 65 L31 16 A60 60 0 0 1 99 16 Z" fill="url(#coneGrad)"/>
        </svg>
      </div>
      <svg width="30" height="30" viewBox="0 0 30 30" class="user-core">
        <circle cx="15" cy="15" r="14" style="fill:var(--blue)" fill-opacity="0.18"/>
        <circle cx="15" cy="15" r="7.5" style="fill:var(--blue)" stroke="#fff" stroke-width="3.2"/>
      </svg>
    </div>`
  });
}
/* ============================================================
   ICONOS DE PIN — pictograma de aseo + insignia de categoría.
   Diseño acordado con el usuario a partir de un set generado con ChatGPT,
   pulido a mano (figuras centradas por cabeza, no por caja; separación
   entre ellas; subidas para compensar que el pin acaba en punta abajo;
   taza de café reducida; pan de la hamburguesa curvo).
   ============================================================ */
const PIN_PATH = 'M128 12c-59.6 0-108 48.4-108 108 0 81 108 128 108 128s108-47 108-128C236 60.4 187.6 12 128 12Z';
const PIN_FIGURES =
  '<g fill="#fff" transform="translate(-2 -16)"><circle cx="96" cy="83" r="13"/><path d="M76 105a12 12 0 0 1 12-12h16a12 12 0 0 1 12 12v48a8 8 0 0 1-8 8h-2v39a9 9 0 0 1-18 0v-39h-4a8 8 0 0 1-8-8Z"/></g>' +
  '<g fill="#fff" transform="translate(18 -16)"><circle cx="144" cy="83" r="13"/><path d="M136 93h16c7 0 11 5 13 12l15 48c2 6-2 11-8 11h-7v36a9 9 0 0 1-18 0v-36h-6v36a9 9 0 0 1-18 0v-36h-7c-6 0-10-5-8-11l15-48c2-7 6-12 13-12Z"/></g>';
const PIN_HEART = '<path fill="#fff" d="M198 214c-5-5-22-16-22-29 0-15 18-20 22-8 4-12 22-7 22 8 0 13-17 24-22 29Z"/>';
const PIN_BADGE_UNCONFIRMED = '<path fill="none" stroke="#fff" stroke-linecap="round" stroke-width="10" d="M187 178c1-11 23-13 23 2 0 10-12 10-12 20"/><circle cx="198" cy="214" r="5" fill="#fff"/>';
const PIN_BADGE = {
  aseo_oficial: '<path fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="11" d="m180 190 12 12 24-27"/>',
  aseo_comunidad: PIN_BADGE_UNCONFIRMED,
  estacion: PIN_BADGE_UNCONFIRMED,
  centro_comercial: PIN_BADGE_UNCONFIRMED,
  bar: '<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"><path d="M181 174h34l-5 15c-4 12-20 12-24 0Z"/><path d="M198 198v15m-12 0h24"/></g>',
  cafeteria: '<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="7" transform="translate(198 190) scale(0.8) translate(-201 -188.8)"><path d="M181 184h27v19c0 7-5 11-12 11h-3c-7 0-12-4-12-11Z"/><path d="M208 189h4c11 0 11 14 0 14h-4m-18-27c-5-6 5-7 0-13m13 13c-5-6 5-7 0-13"/></g>',
  fastfood: '<g stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="7" fill="none"><path d="M184 183 Q198 170 212 183"/><line x1="181" y1="192" x2="215" y2="192"/><line x1="181" y1="202" x2="215" y2="202"/></g>'
};
function pinColor(p) {
  return TIPO_COLOR_FIJO[p.tipo] || ACCENT;
}
function pinSvgMarkup(p) {
  const fav = isFav(p);
  const color = fav ? '#00bcd4' : pinColor(p);
  const badge = fav ? PIN_HEART : (PIN_BADGE[p.tipo] || '');
  return `<svg viewBox="0 0 256 256">` +
    `<path fill="${color}" d="${PIN_PATH}"/>` +
    PIN_FIGURES +
    `<circle cx="198" cy="190" r="37" fill="${color}" stroke="#fff" stroke-width="8"/>` +
    badge +
    `</svg>`;
}
function placeIcon(p) {
  const off = isLikelyOpenNow(p) === false;
  return L.divIcon({
    className: '', iconSize: [38, 42], iconAnchor: [19, 41], popupAnchor: [0, -38],
    html: `<div class="fountain-pin${off ? ' off' : ''}">${pinSvgMarkup(p)}</div>`
  });
}
function nearestIcon(p) {
  return L.divIcon({
    className: '', iconSize: [52, 57], iconAnchor: [26, 56], popupAnchor: [0, -52],
    html: `<div class="fountain-pin nearest-pin">${pinSvgMarkup(p)}</div>`
  });
}

function initMap() {
  map = L.map('map', {
    zoomControl: true, attributionControl: true,
    rotate: true, touchRotate: true, shiftKeyRotate: true, rotateControl: false, bearing: 0
  }).setView([userPos.lat, userPos.lon], 16);

  applyMapTheme();
  if (map.attributionControl) map.attributionControl.setPrefix(false);
  calibrateBearingSign();

  userMarker = L.marker([userPos.lat, userPos.lon], { icon: userIcon(), zIndexOffset: 1000, interactive: false })
               .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -12] });
  const umEl = userMarker.getElement();
  headingConeEl = umEl && umEl.querySelector('.heading-cone');
  acquireCompass();
  accCircle = L.circle([userPos.lat, userPos.lon], {
    radius: userPos.acc || 30, color: '#1f7fe0', weight: 1, opacity: .3, fillOpacity: .08
  }).addTo(map);

  /* Clustering (Leaflet.markercluster) en vez del sistema de rejilla+tope de
     Fuentes de Madrid: con hasta ~13.800 puntos (bares/fastfood incluidos) va
     mucho mejor — probado en el mapa de debug antes de traerlo aquí. Como el
     propio plugin decide qué mostrar según el zoom, no hace falta recalcular
     nada en cada movimiento del mapa (a diferencia del sistema anterior). */
  placeCluster = L.markerClusterGroup({
    disableClusteringAtZoom: clusterSettings.disableClusteringAtZoom, spiderfyOnMaxZoom: false, showCoverageOnHover: false,
    chunkedLoading: true, maxClusterRadius: clusterSettings.maxClusterRadius
  }).addTo(map);
  applyFilters();
  updateUrgencyPanel();

  map.on('moveend zoomend', debounce(saveView, 400));
  map.on('moveend zoomend', updateRecenterState);
  map.on('moveend zoomend', debounce(prefetchTileRing, 150));
  map.on('move', updateFarOverlay);
  map.on('rotate', onMapRotate);
  map.on('rotateend', updateModeButton);
  map.on('click', () => { closeSheet(); closeServicesSheet(false); hideDevContextMenu(); });
  map.on('movestart zoomstart', hideDevContextMenu);
  map.on('contextmenu', (e) => { if (devUnlocked) showDevContextMenu(e.containerPoint, e.latlng); });

  $('recenter').addEventListener('click', recenterToUser);
  $('farBackBtn').addEventListener('click', recenterToUser);
  $('mapMode').addEventListener('click', onModeButton);
  $('fitBtn').addEventListener('click', fitUserAndFountain);

  startTrail();
  if (!freshSession) restoreTarget();
  requestAnimationFrame(() => {
    map.invalidateSize();
    const resumed = !freshSession && (restoreSheetIfWasOpen() || restoreSavedView());
    if (!openSharedPlaceIfAny() && !resumed) fitInitialView();
    rebuildMarkers(); updateModeButton(); updateFitBtn(); updateRecenterState(); updateFarOverlay();
  });
}

/* ---------- recordar dónde estabas al volver a abrir la app ---------- */
function saveView() {
  if (!map) return;
  const c = map.getCenter();
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })); } catch (_) {}
}
function restoreSheetIfWasOpen() {
  let wasOpen = null;
  try { wasOpen = localStorage.getItem(SHEET_OPEN_KEY); } catch (_) {}
  if (wasOpen !== '1' || !selected) return false;
  map.setView([selected.lat, selected.lon], Math.max(map.getZoom(), 17), { animate: false });
  openSheet(selected);
  return true;
}
function restoreSavedView() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch (_) {}
  if (!v || typeof v.lat !== 'number' || typeof v.lon !== 'number') return false;
  map.setView([v.lat, v.lon], v.zoom || 16, { animate: false });
  return true;
}

/* ---------- abrir un lugar compartido por enlace (?f=lat,lon) ---------- */
function openSharedPlaceIfAny() {
  const m = location.search.match(/[?&]f=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return false;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return false;
  let best = null, bestD = Infinity;
  for (const p of allPlaces) {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best || bestD > 30) return false;
  map.setView([best.lat, best.lon], 18, { animate: false });
  openSheet(best);
  return true;
}

/* ---------- marcadores: todos los del filtro actual, agrupados por clúster ---------- */
function refreshAllIcons() {
  for (const p of places) {
    if (p.marker) p.marker.setIcon(p === selected ? nearestIcon(p) : placeIcon(p));
  }
}
function makeMarker(p, isSelected) {
  const m = L.marker([p.lat, p.lon], { icon: isSelected ? nearestIcon(p) : placeIcon(p) })
    .on('click', () => handleMarkerClick(p));
  if (isSelected) m.setZIndexOffset(700);
  p.marker = m;
  return m;
}
/* Reconstruye todos los marcadores del filtro actual: el seleccionado queda
   fuera del clúster (marcador propio, siempre visible sin agrupar); el resto
   entra de golpe en el clúster (addLayers en bloque, rápido incluso con
   miles de puntos), que ya decide solo qué agrupar según el zoom. */
function rebuildMarkers() {
  if (!map || !placeCluster) return;
  placeCluster.clearLayers();
  if (selectedMarker) { map.removeLayer(selectedMarker); selectedMarker = null; }
  const markers = [];
  for (const p of places) {
    if (p === selected) continue;
    markers.push(makeMarker(p, false));
  }
  placeCluster.addLayers(markers);
  if (selected && places.indexOf(selected) !== -1) {
    selectedMarker = makeMarker(selected, true).addTo(map);
  }
}
/* disableClusteringAtZoom/maxClusterRadius son opciones de construcción del
   grupo: Leaflet.markercluster no permite cambiarlas en caliente, así que
   para el ajuste en vivo (modo desarrollador) hay que tirar el grupo y
   crear uno nuevo con los valores actuales. */
function recreateCluster() {
  if (!map) return;
  if (placeCluster) map.removeLayer(placeCluster);
  placeCluster = L.markerClusterGroup({
    disableClusteringAtZoom: clusterSettings.disableClusteringAtZoom, spiderfyOnMaxZoom: false, showCoverageOnHover: false,
    chunkedLoading: true, maxClusterRadius: clusterSettings.maxClusterRadius
  }).addTo(map);
  rebuildMarkers();
}

/* lugar seleccionado = destino resaltado y persistente entre sesiones */
function setTarget(p) {
  const prev = selected;
  selected = p;
  try { localStorage.setItem(TARGET_KEY, p ? favKey(p) : ''); } catch (_) {}
  if (prev && prev !== p) {
    if (selectedMarker) { map.removeLayer(selectedMarker); selectedMarker = null; }
    if (places.indexOf(prev) !== -1) placeCluster.addLayer(makeMarker(prev, false));
  }
  if (p) {
    if (p.marker && placeCluster.hasLayer(p.marker)) placeCluster.removeLayer(p.marker);
    selectedMarker = makeMarker(p, true).addTo(map);
  }
  updateFitBtn();
}
function restoreTarget() {
  let key = null;
  try { key = localStorage.getItem(TARGET_KEY); } catch (_) {}
  if (!key) return;
  const p = allPlaces.find((x) => favKey(x) === key);
  if (p) selected = p;
}

function recomputeDistances() {
  if (!userPos) return;
  for (const p of places) p.dist = haversine(userPos.lat, userPos.lon, p.lat, p.lon);
  places.sort((a, b) => a.dist - b.dist);
  checkVisits();
}
function nearest() { return places.length ? places[0] : null; }

function fitInitialView() {
  if (!userPos || !map) return;
  const near = nearest();
  if (!near) { map.setView([userPos.lat, userPos.lon], 15); return; }
  const radius = Math.max(near.dist * 1.25, MIN_RADIUS);
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(toRad(userPos.lat)));
  const bounds = L.latLngBounds([userPos.lat - dLat, userPos.lon - dLon], [userPos.lat + dLat, userPos.lon + dLon]);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
  toast(`${t('nearest')}: ${fmtDist(near.dist)}`);
}

/* ============================================================
   ORIENTACIÓN DEL MAPA — Norte arriba / Libre / Brújula
   ============================================================ */
function setBearingSafe(deg) {
  if (!map || !map.setBearing) return;
  programmaticBearing = true;
  map.setBearing(deg);
  setTimeout(() => { programmaticBearing = false; }, 80);
}
let mapBearingSign = null;
function calibrateBearingSign() {
  if (!map || !map.setBearing || !map.getBearing) { mapBearingSign = 1; return; }
  const c = map.getCenter();
  const topBearing = () => {
    const p = map.latLngToContainerPoint(c);
    const g = map.containerPointToLatLng({ x: p.x, y: p.y - 100 });
    return bearing(c.lat, c.lng, g.lat, g.lng);
  };
  programmaticBearing = true;
  const b0 = map.getBearing(), a0 = topBearing();
  map.setBearing(b0 + 20);
  const a1 = topBearing();
  map.setBearing(b0);
  programmaticBearing = false;
  const d = ((a1 - a0 + 540) % 360) - 180;
  mapBearingSign = d >= 0 ? 1 : -1;
}
function setMapModeInternal(m) {
  if (mapMode === 'compass' && m !== 'compass') releaseCompass();
  if (mapMode !== 'compass' && m === 'compass') { if (mapBearingSign == null) calibrateBearingSign(); mapHeading = null; acquireCompass(); }
  mapMode = m;
}
function setMode(m) {
  setMapModeInternal(m);
  if (m === 'north') { setBearingSafe(0); toast(t('north')); }
  else if (m === 'compass') {
    if (userPos && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: true });
    toast(t('compass_mode'));
  }
  updateModeButton();
}
function onModeButton() { setMode(mapMode === 'compass' ? 'north' : 'compass'); }
function onMapRotate() {
  if (!programmaticBearing && mapMode !== 'free') { setMapModeInternal('free'); toast(t('free')); }
  updateModeButton();
}
function updateModeButton() {
  const btn = $('mapMode'); if (!btn) return;
  const brg = (map && map.getBearing) ? map.getBearing() : 0;
  const needle = btn.querySelector('.needle');
  if (needle) needle.style.transform = `rotate(${-brg}deg)`;
  btn.classList.toggle('active', mapMode === 'compass');
  updateHeadingCone();
}
const RECENTER_EDGE_MARGIN = 50;
function updateRecenterState() {
  const btn = $('recenter'); if (!btn || !map || !userPos) return;
  const p = map.latLngToContainerPoint([userPos.lat, userPos.lon]);
  const size = map.getSize();
  const offCenter = p.x < RECENTER_EDGE_MARGIN || p.y < RECENTER_EDGE_MARGIN
                 || p.x > size.x - RECENTER_EDGE_MARGIN || p.y > size.y - RECENTER_EDGE_MARGIN;
  btn.classList.toggle('attention', offCenter);
}
function recenterToUser() {
  if (!userPos || !map) return;
  map.setView([userPos.lat, userPos.lon], 16, { animate: true });
  updateRecenterState();
}
/* Oscurece la pantalla según te alejas de la zona con servicios (contra corePlaces,
   no todo allPlaces: barato de recorrer y evita que 13k bares "compensen" el aviso). */
const FAR_DARK_START_KM = 5;
const FAR_DARK_FULL_KM = 60;
function updateFarOverlay() {
  const overlay = $('farOverlay'); if (!overlay || !map || !corePlaces.length) return;
  const c = map.getCenter();
  const km = nearestDistanceKm(c.lat, c.lng);
  const ratio = Math.max(0, Math.min(1, (km - FAR_DARK_START_KM) / (FAR_DARK_FULL_KM - FAR_DARK_START_KM)));
  overlay.style.opacity = ratio;
  overlay.classList.toggle('blackout', ratio >= 1);
}
let coneHeading = null;
let coneRotationDeg = 0;
function updateHeadingCone() {
  if (!headingConeEl) return;
  if (arHeading == null) { headingConeEl.classList.remove('show'); return; }
  coneHeading = smoothAngle(coneHeading, arHeading, MAP_HEADING_SMOOTH);
  const brg = (map && map.getBearing) ? map.getBearing() : 0;
  const screenUp = (mapBearingSign || 1) * brg;
  const target = ((coneHeading - screenUp) % 360 + 360) % 360;
  const delta = ((target - coneRotationDeg) % 360 + 540) % 360 - 180;
  coneRotationDeg += delta;
  headingConeEl.style.transform = `rotate(${coneRotationDeg}deg)`;
  headingConeEl.classList.add('show');
}

/* ============================================================
   BOTÓN "ENCUADRAR"
   ============================================================ */
function updateFitBtn() {
  const b = $('fitBtn'); if (b) b.style.display = selected ? 'flex' : 'none';
}
function fitZoom() {
  const dist = haversine(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const h = (map.getSize && map.getSize().y) || 500;
  const mpp = Math.max(dist, 40) / (h * 0.50);
  const z = Math.log2(156543.03 * Math.cos(toRad(userPos.lat)) / mpp);
  return Math.max(13, Math.min(18, z));
}
function fitUserAndFountain() {
  if (!userPos || !selected || !map) return;
  const z = fitZoom();
  map.setView([userPos.lat, userPos.lon], z, { animate: false });
  if (map.setBearing && map.getBearing) {
    const ang = () => {
      const u = map.latLngToContainerPoint([userPos.lat, userPos.lon]);
      const f = map.latLngToContainerPoint([selected.lat, selected.lon]);
      return Math.atan2(f.y - u.y, f.x - u.x) * 180 / Math.PI;
    };
    const a0 = ang(), b0 = map.getBearing();
    map.setBearing(b0 + 20); let d = ang() - a0; map.setBearing(b0);
    d = ((d + 540) % 360) - 180; const k = d >= 0 ? 1 : -1;
    programmaticBearing = true;
    let err = -90 - ang(); err = ((err + 540) % 360) - 180;
    map.setBearing(map.getBearing() + err / k);
    setTimeout(() => { programmaticBearing = false; }, 150);
    setMapModeInternal('free');
  }
  const size = map.getSize();
  const newCenter = map.containerPointToLatLng([size.x / 2, size.y * 0.20]);
  map.setView(newCenter, z, { animate: false });
  updateModeButton();
}

/* ============================================================
   LIVE position tracking
   ============================================================ */
let lastRecomputePos = null;
function watchPosition() {
  if (getFakeLocation()) return;
  if (geoWatchId != null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userPos = posToObj(pos);
      if (userMarker) userMarker.setLatLng([userPos.lat, userPos.lon]);
      if (accCircle) { accCircle.setLatLng([userPos.lat, userPos.lon]); accCircle.setRadius(userPos.acc || 30); }
      if (mapMode === 'compass' && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: false });
      if (!lastRecomputePos || haversine(lastRecomputePos.lat, lastRecomputePos.lon, userPos.lat, userPos.lon) >= 3) {
        lastRecomputePos = { lat: userPos.lat, lon: userPos.lon };
        recomputeDistances();
        updateUrgencyPanel();
        if (radarOpen) refreshRadar();
      }
      if (selected && $('sheet').classList.contains('open')) updateSheetDistance();
      if ($('ar').style.display === 'block') updateAR();
      updateRecenterState();
    },
    () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

/* ============================================================
   INFO SHEET
   ============================================================ */
function openSheet(p) {
  setTarget(p);
  $('sName').textContent = p.nombre || tipoLabel(p.tipo);
  $('sAddr').textContent = p.direccion || tipoLabel(p.tipo);
  const chips = [];
  chips.push(`<span class="chip dist">${pinSvg()} ${fmtDist(p.dist)} · ${fmtWalkMin(p.dist)}</span>`);
  chips.push(`<span class="chip">${TIPO_EMOJI[p.tipo] || ''} ${tipoLabel(p.tipo)}</span>`);
  chips.push(`<span class="chip">${PAGO_LABEL[p.pago] || p.pago}</span>`);
  const hChip = horarioChip(p);
  if (hChip) chips.push(hChip);
  if (p.accesible === true) chips.push(`<span class="chip">♿ ${t('accessible')}</span>`);
  if (p.cambiador === true) chips.push(`<span class="chip">🚼 ${t('changing_table')}</span>`);
  if (p.agrupacion && p.agrupacion.nombre) chips.push(`<span class="chip">🏢 ${t('inside_of')}: ${p.agrupacion.nombre}</span>`);
  $('sChips').innerHTML = chips.join('');
  renderVisitInfo(p);
  updateFavBtn();
  $('sheet').classList.add('open');
  try { localStorage.setItem(SHEET_OPEN_KEY, '1'); } catch (_) {}
}
function renderVisitInfo(p) {
  const el = $('sVisits'); if (!el) return;
  const v = visits[favKey(p)];
  if (!v) { el.textContent = ''; el.style.display = 'none'; return; }
  const d = new Date(v.last).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  el.textContent = (v.count === 1 ? t('visit_once') : t('visit_many').replace('{n}', v.count)) + ' ' + d;
  el.style.display = 'block';
}
function updateFavBtn() {
  if (!selected) return;
  const on = isFav(selected);
  $('favBtn').classList.toggle('on', on);
  $('favBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
}
function updateSheetDistance() {
  if (!selected) return;
  const el = $('sChips').querySelector('.chip.dist');
  if (el) el.innerHTML = `${pinSvg()} ${fmtDist(selected.dist)} · ${fmtWalkMin(selected.dist)}`;
}
function pinSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>'; }
function checkSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'; }
function crossSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; }

function closeSheet() {
  $('sheet').classList.remove('open');
  try { localStorage.setItem(SHEET_OPEN_KEY, '0'); } catch (_) {}
}
$('sheetClose').addEventListener('click', closeSheet);

function handleMarkerClick(p) {
  if (selected === p) { closeSheet(); setTarget(null); }
  else openSheet(p);
}

(function enableSheetDrag() {
  const el = $('sheet'); let startY = null, dy = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    startY = e.touches[0].clientY; dy = 0; el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) { el.style.transform = (window.innerWidth >= 760 ? 'translateX(-50%) ' : '') + `translateY(${dy}px)`; e.preventDefault(); }
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (startY == null) return;
    el.style.transition = ''; el.style.transform = '';
    if (dy > 90) closeSheet();
    startY = null; dy = 0;
  });
})();

$('favBtn').addEventListener('click', () => {
  if (!selected) return;
  toggleFav(selected);
  updateFavBtn();
  if (selected.marker) selected.marker.setIcon(nearestIcon(selected));
  if (filters.favOnly) { applyFilters(); rebuildMarkers(); }
  if (radarOpen) refreshRadar();
});

$('shareBtn').addEventListener('click', async () => {
  if (!selected) return;
  const label = selected.nombre || tipoLabel(selected.tipo);
  const url = `${location.origin}${location.pathname}?f=${selected.lat.toFixed(5)},${selected.lon.toFixed(5)}`;
  const text = [t('share_msg'), label, selected.direccion].filter(Boolean).join(' — ');
  if (navigator.share) {
    try { await navigator.share({ title: t('share_msg'), text, url }); } catch (_) {}
  } else {
    try { await navigator.clipboard.writeText(url); toast(t('share_copied')); }
    catch (_) { toast(url); }
  }
});

$('btnRoute').addEventListener('click', () => {
  if (!selected || !userPos) return;
  const d = selected, u = userPos;
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const url = isiOS
    ? `https://maps.apple.com/?saddr=${u.lat},${u.lon}&daddr=${d.lat},${d.lon}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&origin=${u.lat},${u.lon}&destination=${d.lat},${d.lon}&travelmode=walking`;
  window.open(url, '_blank', 'noopener');
});

/* ============================================================
   AR MODE (cámara + flecha de brújula suavizada)
   ============================================================ */
let arStream = null;
$('btnAR').addEventListener('click', startAR);
$('arClose').addEventListener('click', stopAR);

async function startAR() {
  if (!selected) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(t('ar_cam_no')); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') toast(t('ar_perm'));
    }
  } catch (_) {}
  try {
    arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) { toast(t('ar_cam_err')); return; }
  $('arVideo').srcObject = arStream;
  $('ar').style.display = 'block';
  $('arName').textContent = $('sName').textContent;
  arHeading = null; arPitch = null; arArrivedVibrated = false;
  acquireCompass();
  updateAR();
}
function stopAR() {
  $('ar').style.display = 'none';
  $('arTarget').style.display = 'none';
  if (arStream) { arStream.getTracks().forEach(tr => tr.stop()); arStream = null; }
  releaseCompass();
}
let compassUsers = 0;
function acquireCompass() { compassUsers++; if (compassUsers === 1) startCompass(); }
function releaseCompass() { compassUsers = Math.max(0, compassUsers - 1); if (compassUsers === 0) stopCompass(); }
let arAbsoluteSeen = false;
let arFallbackTimer = null;
function startCompass() {
  arAbsoluteSeen = false;
  window.addEventListener('deviceorientationabsolute', onOrientAbsolute, true);
  arFallbackTimer = setTimeout(() => {
    if (!arAbsoluteSeen) window.addEventListener('deviceorientation', onOrient, true);
  }, 300);
}
function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientAbsolute, true);
  window.removeEventListener('deviceorientation', onOrient, true);
  if (arFallbackTimer) { clearTimeout(arFallbackTimer); arFallbackTimer = null; }
  arAbsoluteSeen = false;
}
function onOrientAbsolute(e) { arAbsoluteSeen = true; onOrient(e); }
function onOrient(e) {
  if (typeof e.beta === 'number') {
    const p = Math.max(0, Math.min(90, e.beta));
    arPitch = (arPitch == null) ? p : arPitch + 0.10 * (p - arPitch);
  }
  let h = null, needsScreenFix = true;
  if (typeof e.webkitCompassHeading === 'number') { h = e.webkitCompassHeading; needsScreenFix = false; }
  else if (typeof e.alpha === 'number') h = 360 - e.alpha;
  if (h != null) {
    const so = needsScreenFix ? ((screen.orientation && screen.orientation.angle) || window.orientation || 0) : 0;
    const raw = (h + so + 360) % 360;
    let alpha = HEADING_SMOOTH;
    if (arHeading != null) {
      const delta = Math.abs(((raw - arHeading + 540) % 360) - 180);
      if (delta > HEADING_JUMP) alpha = HEADING_SMOOTH * 0.2;
    }
    arHeading = smoothAngle(arHeading, raw, alpha);

    if (mapMode === 'compass') {
      mapHeading = smoothAngle(mapHeading, raw, MAP_HEADING_SMOOTH);
      const now = Date.now();
      if (now - lastMapBearingUpdate > MAP_BEARING_THROTTLE) {
        lastMapBearingUpdate = now;
        if (userPos && map) map.setView([userPos.lat, userPos.lon], map.getZoom(), { animate: false });
        setBearingSafe(mapBearingSign * mapHeading);
      }
      if (tileLayer && now - lastTileRefresh > 800) {
        lastTileRefresh = now;
        if (typeof tileLayer._update === 'function') tileLayer._update(map.getCenter());
        else if (map) map.invalidateSize({ pan: false });
      }
    }
    updateHeadingCone();
  }
  updateAR();
  if (radarOpen) updateRadarRotation();
}
function updateAR() {
  if (!selected || !userPos || $('ar').style.display !== 'block') return;
  const dist = haversine(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const brg = bearing(userPos.lat, userPos.lon, selected.lat, selected.lon);
  const dEl = $('arDist'), hintEl = $('arHint');
  if (dist < 12) {
    dEl.textContent = t('ar_almost'); dEl.classList.add('ar-arrived');
    hintEl.textContent = t('ar_steps');
    if (!arArrivedVibrated) { arArrivedVibrated = true; if (navigator.vibrate) navigator.vibrate([40, 60, 90]); }
  } else {
    dEl.textContent = fmtDist(dist); dEl.classList.remove('ar-arrived');
    hintEl.textContent = arHeading == null ? t('ar_cal')
                       : (arPitch != null && arPitch > 45 ? t('ar_follow') : t('ar_lift'));
    arArrivedVibrated = false;
  }
  const offset = arHeading == null ? 0 : (((brg - arHeading + 540) % 360) - 180);
  const tilt = arPitch == null ? 0 : Math.max(0, Math.min(1, (arPitch - 8) / (78 - 8)));
  $('arArrow').style.transform = `rotateX(${tilt * 70}deg) rotateZ(${offset}deg)`;

  const tgt = $('arTarget');
  if (tilt > 0.45 && Math.abs(offset) < 60) {
    const x = 50 + (offset / 60) * 42;
    tgt.style.left = Math.max(6, Math.min(94, x)) + '%';
    $('arTargetDist').textContent = fmtDist(dist);
    tgt.style.display = 'flex';
  } else {
    tgt.style.display = 'none';
  }
  updateArRadar(tilt);
}

const AR_RADAR_MAX = 6;
const AR_RADAR_RANGE_M = 400;
let arRadarEls = [];
function ensureArRadarEls(n) {
  const wrap = $('arRadar'); if (!wrap) return;
  while (arRadarEls.length < n) {
    const div = document.createElement('div');
    div.className = 'ar-radar-pin';
    div.innerHTML = `<svg viewBox="0 0 34 42"><path d="M17 1 C17 1 4 15 4 25 a13 13 0 0 0 26 0 C30 15 17 1 17 1 Z" fill="#8fcdff" stroke="#fff" stroke-width="2"/><path d="M17 12 c-3 4 -5 6.5 -5 9 a5 5 0 0 0 10 0 c0 -2.5 -2 -5 -5 -9 z" fill="#fff"/></svg><span class="ar-radar-d"></span>`;
    wrap.appendChild(div);
    arRadarEls.push(div);
  }
}
function updateArRadar(tilt) {
  const others = places.filter(p => p !== selected && p.dist != null && p.dist <= AR_RADAR_RANGE_M).slice(0, AR_RADAR_MAX);
  ensureArRadarEls(others.length);
  arRadarEls.forEach((el, i) => {
    const p = others[i];
    if (!p) { el.style.display = 'none'; return; }
    const brg = bearing(userPos.lat, userPos.lon, p.lat, p.lon);
    const offset = arHeading == null ? 0 : (((brg - arHeading + 540) % 360) - 180);
    if (tilt > 0.4 && Math.abs(offset) < 55) {
      const x = 50 + (offset / 55) * 44;
      el.style.left = Math.max(4, Math.min(96, x)) + '%';
      el.querySelector('.ar-radar-d').textContent = fmtDist(p.dist);
      el.style.display = 'flex';
      el.onclick = () => retargetAR(p);
    } else {
      el.style.display = 'none';
    }
  });
}
function retargetAR(p) {
  setTarget(p);
  $('arName').textContent = p.nombre || tipoLabel(p.tipo);
  arArrivedVibrated = false;
  updateAR();
}

/* ============================================================
   MODO RADAR — pantalla completa, estilo sonar. Los aseos se dibujan como
   puntos según distancia (radio) y rumbo (ángulo); el grupo entero gira con
   la brújula del móvil para que "arriba" sea siempre hacia donde apuntas
   (igual que en AR), mientras el barrido decorativo gira solo, aparte.
   ============================================================ */
const RADAR_OUTER_PX = 140;                   // debe coincidir con el radio máximo usado en el SVG
const RADAR_BLIP_CAP = 150;                   // tope de puntos dibujados (legibilidad + rendimiento)
const RADAR_SCALE_EXP = 0.55;                 // <1 = escala raíz: separa lo cercano, comprime lo lejano
/* Fracciones fijas de anillo: con el rango por defecto (30') reproducen
   exactamente 5'/10'/20'/30' como se pidió; al hacer zoom se re-escalan
   proporcionalmente (p.ej. con rango 60' pasan a ser 10'/20'/40'/60'). */
const RADAR_RING_FRACS = [1 / 6, 1 / 3, 2 / 3, 1];
const RADAR_RANGE_PRESETS_MIN = [5, 10, 20, 30, 60, 120];
let radarRangeIdx = 3;   // 30 min, el rango original
let radarOpen = false;
let radarMap = null;
let lastRadarBearingUpdate = 0;

function radarRangeMin() { return RADAR_RANGE_PRESETS_MIN[radarRangeIdx]; }
function fmtRadarMin(min) {
  const v = min < 10 ? Math.round(min * 2) / 2 : Math.round(min);
  return (Number.isInteger(v) ? v : v.toFixed(1)) + '′';
}
function radarRatioToPx(ratio) { return Math.pow(Math.min(ratio, 1), RADAR_SCALE_EXP) * RADAR_OUTER_PX; }
function radarPointFor(dist, brg) {
  const r = radarRatioToPx(dist / (radarRangeMin() * 80));
  const rad = toRad(brg);
  return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
}
function updateRadarRings() {
  const range = radarRangeMin();
  const rings = document.querySelectorAll('.radar-ring');
  const labels = document.querySelectorAll('.radar-ring-label');
  RADAR_RING_FRACS.forEach((f, i) => {
    const r = radarRatioToPx(f);
    if (rings[i]) rings[i].setAttribute('r', r.toFixed(1));
    if (labels[i]) { labels[i].setAttribute('x', (r + 3).toFixed(1)); labels[i].textContent = fmtRadarMin(range * f); }
  });
}
function syncRadarZoomButtons() {
  if ($('radarZoomIn')) $('radarZoomIn').disabled = radarRangeIdx === 0;
  if ($('radarZoomOut')) $('radarZoomOut').disabled = radarRangeIdx === RADAR_RANGE_PRESETS_MIN.length - 1;
}
function setRadarRange(idx) {
  radarRangeIdx = Math.max(0, Math.min(RADAR_RANGE_PRESETS_MIN.length - 1, idx));
  syncRadarZoomButtons();
  updateRadarRings();
  refreshRadar();
}
function renderRadarBlips() {
  const g = $('radarBlipsGroup'); if (!g || !userPos) return;
  g.innerHTML = '';
  const rangeM = radarRangeMin() * 80;
  const candidates = places.filter(p => p.dist != null && p.dist <= rangeM).slice(0, RADAR_BLIP_CAP);
  const emptyEl = $('radarEmpty');
  if (emptyEl) {
    emptyEl.style.display = candidates.length ? 'none' : 'block';
    if (!candidates.length) emptyEl.textContent = t('radar_empty').replace('{min}', radarRangeMin());
  }
  const ns = 'http://www.w3.org/2000/svg';
  for (const p of candidates) {
    const brg = bearing(userPos.lat, userPos.lon, p.lat, p.lon);
    const { x, y } = radarPointFor(p.dist, brg);
    const r = p === selected ? 7 : 4.5;
    const fav = isFav(p);

    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x.toFixed(1));
    c.setAttribute('cy', y.toFixed(1));
    c.setAttribute('r', r);
    c.setAttribute('fill', fav ? '#00bcd4' : pinColor(p));
    c.setAttribute('class', 'radar-blip' + (fav ? ' fav' : ''));
    c.dataset.id = p.id;
    const title = document.createElementNS(ns, 'title');
    title.textContent = p.nombre || tipoLabel(p.tipo);
    c.appendChild(title);
    g.appendChild(c);

    /* insignia simplificada (demasiado pequeño para el glifo real): punto
       sólido = aseo_oficial (100% confirmado), anillo hueco = el resto
       (comunidad/estación/CC/bar/cafetería/fastfood - todo lo que es
       "probablemente hay aseo" en vez de un aseo garantizado). */
    const br = Math.max(1, r * 0.34);
    const badge = document.createElementNS(ns, 'circle');
    badge.setAttribute('cx', (x + r * 0.62).toFixed(1));
    badge.setAttribute('cy', (y + r * 0.62).toFixed(1));
    badge.setAttribute('r', br.toFixed(1));
    badge.setAttribute('fill', fav ? '#fff' : (p.tipo === 'aseo_oficial' ? '#fff' : 'none'));
    badge.setAttribute('stroke', '#fff');
    badge.setAttribute('stroke-width', Math.max(0.6, br * 0.5).toFixed(1));
    badge.style.pointerEvents = 'none';
    g.appendChild(badge);
  }
}
function updateRadarRotation() {
  const g = $('radarBlipsGroup'); if (!g) return;
  const heading = arHeading == null ? 0 : arHeading;
  g.setAttribute('transform', `rotate(${-heading})`);
  updateRadarMapBearing();
}
function refreshRadar() {
  renderRadarBlips();
  updateRadarMap();
}

/* ---- Mapa real de fondo, atenuado por CSS, sin interacción propia: solo
   decorativo/de referencia. Se crea una vez y se reutiliza (no se destruye
   al cerrar el radar, para no recargar teselas cada vez). ---- */
function radarMapZoomForRange() {
  const wrap = $('radarWrap');
  const pxWidth = (wrap && wrap.clientWidth) || 320;
  const outerPxScreen = RADAR_OUTER_PX * (pxWidth / 320);
  const mpp = (radarRangeMin() * 80) / outerPxScreen;
  return Math.max(3, Math.min(19, Math.log2(156543.03 * Math.cos(toRad(userPos.lat)) / mpp)));
}
function ensureRadarMap() {
  if (radarMap || !userPos || !$('radarMapBg')) return;
  radarMap = L.map('radarMapBg', {
    zoomControl: false, attributionControl: false, dragging: false, touchZoom: false,
    scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false,
    tap: false, fadeAnimation: false, zoomAnimation: false, inertia: false,
    rotate: true, rotateControl: false, bearing: 0
  }).setView([userPos.lat, userPos.lon], radarMapZoomForRange());
  L.tileLayer(TILES.positron.url, { subdomains: TILES.positron.sub, maxZoom: 20 }).addTo(radarMap);
}
function updateRadarMap() {
  if (!radarMap || !userPos) return;
  radarMap.setView([userPos.lat, userPos.lon], radarMapZoomForRange(), { animate: false });
}
function updateRadarMapBearing() {
  if (!radarMap || !radarMap.setBearing) return;
  const now = Date.now();
  if (now - lastRadarBearingUpdate < MAP_BEARING_THROTTLE) return;
  lastRadarBearingUpdate = now;
  const heading = arHeading == null ? 0 : arHeading;
  radarMap.setBearing((mapBearingSign || 1) * heading);
}

function openRadarMode() {
  if (!userPos) return;
  closeSheet(); closeServicesSheet(false);
  radarOpen = true;
  $('radar').style.display = 'flex';
  arHeading = null;
  acquireCompass();
  syncRadarZoomButtons();
  updateRadarRings();
  renderRadarBlips();
  updateRadarRotation();
  ensureRadarMap();
  if (radarMap) { radarMap.invalidateSize(); updateRadarMap(); }
}
function closeRadarMode() {
  radarOpen = false;
  $('radar').style.display = 'none';
  releaseCompass();
}
if ($('radarModeBtn')) $('radarModeBtn').addEventListener('click', openRadarMode);
if ($('radarClose')) $('radarClose').addEventListener('click', closeRadarMode);
if ($('radarZoomIn')) $('radarZoomIn').addEventListener('click', () => setRadarRange(radarRangeIdx - 1));
if ($('radarZoomOut')) $('radarZoomOut').addEventListener('click', () => setRadarRange(radarRangeIdx + 1));
if ($('radarBlipsGroup')) $('radarBlipsGroup').addEventListener('click', (e) => {
  const el = e.target.closest('.radar-blip'); if (!el) return;
  const p = allPlaces.find((x) => x.id === el.dataset.id);
  if (!p) return;
  closeRadarMode();
  map.setView([p.lat, p.lon], 17, { animate: true });
  openSheet(p);
});

/* ============================================================
   UI wiring + BOOT
   ============================================================ */
if ($('appVersion')) $('appVersion').textContent = 'v' + APP_VERSION;
if ($('aboutVersion')) $('aboutVersion').textContent = 'v' + APP_VERSION;

async function forceUpdate(ev) {
  if (ev) ev.preventDefault();
  toast(t('updating'));
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (self.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    const html = await fetch(location.pathname, { cache: 'reload' }).then(r => r.text()).catch(() => null);
    if (html) {
      const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map(m => m[1]);
      await Promise.all(urls.map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
    }
  } catch (_) {}
  location.replace(location.pathname + '?u=' + Date.now());
}
if ($('forceUpdate')) $('forceUpdate').addEventListener('click', forceUpdate);

/* ============================================================
   MODO DESARROLLADOR (oculto) — 5 toques en el ❤️ del pie de Ajustes.
   ============================================================ */
function showDevMode() {
  if ($('devGroup')) $('devGroup').style.display = '';
  syncDevUI();
}
function syncDevUI() {
  const fl = fakeLocationFromDev();
  if ($('devFakeLoc') && fl) $('devFakeLoc').value = `${fl.lat},${fl.lon}`;
  if ($('devFakeLocStatus')) {
    $('devFakeLocStatus').textContent = fl
      ? `Simulando ubicación: ${fl.lat}, ${fl.lon}`
      : 'Usando el GPS real.';
  }
  if ($('devClusterZoom')) {
    $('devClusterZoom').value = clusterSettings.disableClusteringAtZoom;
    $('devClusterZoomVal').textContent = clusterSettings.disableClusteringAtZoom;
  }
  if ($('devClusterRadius')) {
    $('devClusterRadius').value = clusterSettings.maxClusterRadius;
    $('devClusterRadiusVal').textContent = clusterSettings.maxClusterRadius;
  }
}
if ($('devClusterZoom')) $('devClusterZoom').addEventListener('input', () => {
  clusterSettings.disableClusteringAtZoom = Number($('devClusterZoom').value);
  $('devClusterZoomVal').textContent = clusterSettings.disableClusteringAtZoom;
  saveClusterSettings(); recreateCluster();
});
if ($('devClusterRadius')) $('devClusterRadius').addEventListener('input', () => {
  clusterSettings.maxClusterRadius = Number($('devClusterRadius').value);
  $('devClusterRadiusVal').textContent = clusterSettings.maxClusterRadius;
  saveClusterSettings(); recreateCluster();
});
if ($('devClusterReset')) $('devClusterReset').addEventListener('click', () => {
  clusterSettings = Object.assign({}, CLUSTER_DEFAULTS);
  saveClusterSettings(); syncDevUI(); recreateCluster();
});
let devUnlocked = false;
try { devUnlocked = localStorage.getItem(DEV_UNLOCKED_KEY) === '1'; } catch (_) {}
if (devUnlocked) showDevMode();

let heartTaps = 0, heartTapTimer = null;
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#footerHeart')) return;
  heartTaps++;
  clearTimeout(heartTapTimer);
  heartTapTimer = setTimeout(() => { heartTaps = 0; }, 1500);
  if (heartTaps >= 5) {
    heartTaps = 0;
    if (!devUnlocked) {
      devUnlocked = true;
      try { localStorage.setItem(DEV_UNLOCKED_KEY, '1'); } catch (_) {}
      showDevMode();
      toast('🛠️ Modo desarrollador activado');
    }
  }
});
function applyDevFakeLoc(lat, lon) {
  try { localStorage.setItem(DEV_FAKELOC_KEY, JSON.stringify({ lat, lon })); } catch (_) {}
  toast('Ubicación simulada. Recargando…');
  setTimeout(() => location.replace(location.pathname), 500);
}
/* Clic derecho en el mapa (modo dev): fija la ubicación EN VIVO, sin recargar
   — mucho más cómodo para probar el panel de urgencia, el aviso de "fuera de
   Madrid", etc. mientras se explora el mapa. También la persiste en
   DEV_FAKELOC_KEY, igual que el resto del modo dev, para que sobreviva a un
   refresco de página. Si había un watchPosition real activo, lo paramos: si
   no, la siguiente lectura de GPS pisaría la ubicación fijada a mano. */
function setDevLocationLive(lat, lon) {
  try { localStorage.setItem(DEV_FAKELOC_KEY, JSON.stringify({ lat, lon })); } catch (_) {}
  if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
  userPos = { lat, lon, acc: 20 };
  if (userMarker) userMarker.setLatLng([lat, lon]);
  if (accCircle) { accCircle.setLatLng([lat, lon]); accCircle.setRadius(20); }
  if (mapMode === 'compass' && map) map.setView([lat, lon], map.getZoom(), { animate: false });
  lastRecomputePos = null;
  recomputeDistances();
  updateUrgencyPanel();
  if (radarOpen) refreshRadar();
  updateRecenterState();
  if (selected && $('sheet').classList.contains('open')) updateSheetDistance();
  syncDevUI();
  toast(`📍 Ubicación fijada: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
}
let devContextLatLng = null;
function hideDevContextMenu() {
  const el = $('devContextMenu'); if (el) el.style.display = 'none';
}
function showDevContextMenu(containerPoint, latlng) {
  const el = $('devContextMenu'); if (!el) return;
  devContextLatLng = latlng;
  el.style.left = containerPoint.x + 'px';
  el.style.top = containerPoint.y + 'px';
  el.style.display = 'block';
}
if ($('devSetLocHere')) $('devSetLocHere').addEventListener('click', () => {
  if (devContextLatLng) setDevLocationLive(devContextLatLng.lat, devContextLatLng.lng);
  hideDevContextMenu();
});
document.addEventListener('click', (e) => {
  const menu = $('devContextMenu');
  if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) hideDevContextMenu();
});
if ($('devFakeLocApply')) $('devFakeLocApply').addEventListener('click', () => {
  const v = ($('devFakeLoc').value || '').trim();
  const m = v.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (!m) { toast('Formato: lat,lon (p.ej. 40.4169,-3.7035)'); return; }
  applyDevFakeLoc(parseFloat(m[1]), parseFloat(m[2]));
});
/* Atajo pedido explícitamente: un toque simula la Puerta del Sol sin tener que escribir nada */
if ($('devFakeLocSol')) $('devFakeLocSol').addEventListener('click', () => {
  if ($('devFakeLoc')) $('devFakeLoc').value = `${MADRID_SOL.lat},${MADRID_SOL.lon}`;
  applyDevFakeLoc(MADRID_SOL.lat, MADRID_SOL.lon);
});
if ($('devFakeLocClear')) $('devFakeLocClear').addEventListener('click', () => {
  try { localStorage.removeItem(DEV_FAKELOC_KEY); } catch (_) {}
  toast('Volviendo al GPS real. Recargando…');
  setTimeout(() => location.replace(location.pathname), 500);
});
if ($('devWipeBtn')) $('devWipeBtn').addEventListener('click', () => {
  if (!confirm('¿Borrar todos los datos personales (favoritos, ajustes, visitas, filtros...) y empezar de cero? Esto no se puede deshacer.')) return;
  try {
    [FAV_KEY, TARGET_KEY, SHEET_OPEN_KEY, VISITS_KEY, LAST_ACTIVE_KEY, VIEW_KEY, FILTERS_KEY,
     SETTINGS_KEY, DEV_FAKELOC_KEY, DEV_UNLOCKED_KEY, CLUSTER_KEY, 'aseos_auto_updated_v']
      .forEach(k => localStorage.removeItem(k));
    sessionStorage.clear();
  } catch (_) {}
  location.replace(location.pathname);
});

/* ---- Comprobar si hay versión nueva publicada (vs. la cacheada) ---- */
let updateAvailable = null;
function reflectUpdate() {
  const b = $('forceUpdate'); if (!b) return;
  if (updateAvailable && updateAvailable !== APP_VERSION) {
    b.classList.add('has-update');
    b.textContent = `${t('update_to')} v${updateAvailable}`;
  } else {
    b.classList.remove('has-update');
    b.innerHTML = `<span id="aboutVersion">v${APP_VERSION}</span>`;
  }
}
function checkForUpdate(auto) {
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(r => (r && r.ok) ? r.json() : null)
    .then(d => {
      if (d && d.version && d.version !== APP_VERSION) {
        updateAvailable = d.version;
        reflectUpdate();
        let already = null;
        try { already = localStorage.getItem('aseos_auto_updated_v'); } catch (_) {}
        if (auto && already !== d.version) {
          try { localStorage.setItem('aseos_auto_updated_v', d.version); } catch (_) {}
          forceUpdate();
          return;
        }
        toast(`${t('update_available')} (v${d.version})`);
      }
    })
    .catch(() => {});
}

$('fFav').addEventListener('change', onFilterChange);
$('fEmergency').addEventListener('change', onFilterChange);
$('catBar').addEventListener('change', onFilterChange);
$('catCafeteria').addEventListener('change', onFilterChange);
$('catFastfood').addEventListener('change', onFilterChange);
$('catCC').addEventListener('change', onFilterChange);

/* ---- Ajustes ---- */
$('settingsBtn').addEventListener('click', () => { closeSheet(); otherPickerOpen = false; syncSettingsUI(); $('settings').classList.add('open'); });
$('settingsClose').addEventListener('click', () => $('settings').classList.remove('open'));
$('setTheme').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.theme = b.dataset.theme; saveSettings(); applyTheme(); syncSettingsUI();
}));
$('setMap').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.map = b.dataset.map; saveSettings(); applyMapTheme(); syncSettingsUI();
}));
$('setAccent').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  settings.accent = b.dataset.accent; saveSettings(); applyAccent(); syncSettingsUI();
}));
$('setLang').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.lang === 'other') {
    otherPickerOpen = true;
  } else {
    otherPickerOpen = false;
    settings.lang = b.dataset.lang; saveSettings(); applyI18n(); renderStatus();
  }
  syncSettingsUI();
}));
if ($('setLangOther')) $('setLangOther').addEventListener('change', () => {
  const v = $('setLangOther').value;
  if (!v) return;
  settings.lang = v; saveSettings(); applyI18n(); renderStatus(); syncSettingsUI();
});
$('fTrail').addEventListener('change', () => {
  settings.trailOn = $('fTrail').checked; saveSettings();
  if (settings.trailOn) startTrail(); else clearTrailLayer();
  renderTrail(); syncSettingsUI();
});
$('fTrailLen').addEventListener('input', () => {
  settings.trailLen = parseInt($('fTrailLen').value, 10); saveSettings();
  if ($('trailLenVal')) $('trailLenVal').textContent = trailMax();
  if (trail.length > trailMax()) trail.length = trailMax();
  renderTrail();
});
$('exportBtn').addEventListener('click', exportData);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

window.addEventListener('orientationchange', () => { if (map) setTimeout(() => map.invalidateSize(), 300); });

loadLanguages().then(() => {
  applyI18n(); populateOtherLanguages(); syncSettingsUI();
  renderStatus();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let isTWA = document.referrer.startsWith('android-app://');
if (isTWA) { try { sessionStorage.setItem('is_twa', '1'); } catch (_) {} }
else { try { isTWA = sessionStorage.getItem('is_twa') === '1'; } catch (_) {} }
if (isTWA && $('donateBtn')) {
  $('donateBtn').style.display = 'none';
}

(async function boot() {
  try { await ensureData(); }
  catch (e) { setUpdatedError(); }
  setTimeout(() => checkForUpdate(true), 600);
  autoStartIfAllowed();
})();
