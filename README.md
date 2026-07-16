# Aseos Madrid

App (PWA) para encontrar el aseo público más cercano en Madrid, con bares, fastfood
y centros comerciales cercanos como alternativa "de emergencia". Hermana de
[Fuentes de Madrid](https://github.com/ivanram/fuentes-madrid), del mismo autor —
comparte mapa, temas, ajustes y mecánica general.

## Fuentes de datos (por prioridad)

1. **Aseos oficiales** — [Ayuntamiento de Madrid](https://datos.madrid.es/dataset/300103-0-aseos-publicos-operativos) (CC BY 4.0). Gratis, 24h, accesibles.
2. **Bares/cafeterías/fastfood y centros comerciales** — [Censo de Locales, Actividades y Terrazas](https://datos.madrid.es/dataset/200085-0-censo-locales) del Ayuntamiento (CC BY 4.0), actualizado a diario, filtrado por locales con situación "Abierto".
3. **Estaciones** — Atocha y Chamartín (media/larga distancia), fijadas a mano.

## Uso local

```
python scripts/build_data.py   # genera data/aseos.json
python -m http.server 8034     # sirve la app localmente
```

Abre `http://localhost:8034/index.html` (la app) o `http://localhost:8034/map.html` (mapa de debug, sin UI, para inspeccionar los datos).

## Estructura

- `scripts/build_data.py` — script de construcción de la base de datos (sin dependencias externas, solo Python estándar).
- `index.html` / `app.js` / `styles.css` / `themes.js` / `sw.js` — la app (mapa, filtros, favoritos, AR, ajustes...).
- `map.html` — mapa de debug con Leaflet para visualizar los datos generados, con clustering para las categorías grandes.
- `languages/` — cadenas de idioma (de momento solo `es.json`; el mecanismo ya soporta añadir más).
- `data/aseos.json` — generado por `build_data.py`, versionado en git y actualizado a diario por GitHub Actions.
- `icon-192.png` / `icon-512.png` — **icono placeholder**, pendiente de un icono real.

## GitHub Actions

- `update-data.yml` — reconstruye `data/aseos.json` a diario (05:00 UTC) y lo comitea si cambió.
- `deploy-pages.yml` — publica en GitHub Pages tras cada push a `main` o cada vez que `update-data.yml` termina con éxito.
