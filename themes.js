/* ============================================================
   Datos de presentación: teselas, temas de mapa y paletas.
   Separado de app.js para que la lógica quede más ligera.
   (Variables globales: las usa app.js.)
   ============================================================ */

/* Teselas base (sin clave/API). Los temas las combinan con filtros CSS. */
const TILES = {
  voyager:  { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  positron: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', sub: 'abcd' },
  osm:      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc' }
};

/* Cada tema = variante clara y oscura (según el tema de la app). f = filtro CSS.
   Los oscuros parten de un mapa CLARO invertido → gris oscuro legible (no negro). */
const MAP_THEMES = {
  moderno:     { light: { t: 'voyager',  f: '' },
                 dark:  { t: 'voyager',  f: 'invert(1) hue-rotate(180deg) contrast(.86) brightness(1.08)' } },
  clasico:     { light: { t: 'osm',      f: '' },
                 dark:  { t: 'osm',      f: 'invert(1) hue-rotate(180deg) contrast(.86) brightness(1.08)' } },
  minimalista: { light: { t: 'positron', f: '' },
                 dark:  { t: 'positron', f: 'invert(1) hue-rotate(180deg) contrast(.7) brightness(1.22)' } },
  /* Cyberpunk: recolorea el mapa por luminosidad con un filtro SVG "duotone"
     (definido en index.html) en vez de solo rotar el tono — así sale igual de
     vivo/legible sea cual sea la tesela, y el neón solo funciona con fondo
     oscuro, así que este tema usa siempre la variante oscura. */
  cyberpunk:   { light: { t: 'osm', f: 'invert(1) contrast(1.1) brightness(1.05) url(#duotone-cyberpunk)' },
                 dark:  { t: 'osm', f: 'invert(1) contrast(1.15) brightness(1.1) url(#duotone-cyberpunk)' } },
  /* Colorido: vivo pero legible. La tesela OSM ya tiene color real (agua, parques,
     edificios), así que basta con realzar saturación en vez de forzar un tinte. */
  colorido:    { light: { t: 'osm',      f: 'saturate(1.9) contrast(1.08) brightness(1.03)' },
                 dark:  { t: 'osm',      f: 'invert(1) hue-rotate(180deg) saturate(2.4) contrast(1) brightness(1.1)' } },
  /* Sepia: monocromo amarronado, con un tono sepia más marcado. */
  sepia:       { light: { t: 'osm',      f: 'sepia(.75) saturate(.4) contrast(1.12) brightness(1)' },
                 dark:  { t: 'osm',      f: 'invert(1) hue-rotate(180deg) sepia(.85) saturate(1.5) contrast(.86) brightness(1.05)' } }
};

/* Paletas de color de acento. */
const ACCENTS = {
  blue:   { main: '#1f7fe0', d: '#1668bd', l: '#3ea8ff' },
  teal:   { main: '#0ca7a0', d: '#0a847e', l: '#2bc9c2' },
  green:  { main: '#2faa4e', d: '#24863d', l: '#46c969' },
  purple: { main: '#7c5cff', d: '#6442e6', l: '#9a82ff' },
  red:    { main: '#e23b4e', d: '#c02438', l: '#f06070' },
  orange: { main: '#f08a1d', d: '#cf6f0c', l: '#ffa84a' }
};
