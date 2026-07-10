# Aseos Madrid

Mapa de aseos públicos y servicios "de emergencia" (bares, fastfood, centros comerciales) en Madrid.

## Fuentes de datos (por prioridad)

1. **Aseos oficiales** — [Ayuntamiento de Madrid](https://datos.madrid.es/dataset/300103-0-aseos-publicos-operativos) (CC BY 4.0). Gratis, 24h, accesibles.
2. **Bares/cafeterías/fastfood y centros comerciales** — [Censo de Locales, Actividades y Terrazas](https://datos.madrid.es/dataset/200085-0-censo-locales) del Ayuntamiento (CC BY 4.0), actualizado a diario, filtrado por locales con situación "Abierto".
3. **Aseos de comunidad** — [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), vía Overpass API, solo para aseos no cubiertos por el dataset oficial.
4. **Estaciones** — Atocha y Chamartín (media/larga distancia), fijadas a mano.

## Uso

```
python scripts/build_data.py   # genera data/aseos.json
python -m http.server 8034     # sirve el mapa localmente
```

Abre `http://localhost:8034/map.html`.

## Estructura

- `scripts/build_data.py` — script de construcción de la base de datos (sin dependencias externas, solo Python estándar).
- `map.html` — mapa de debug con Leaflet para visualizar los datos generados.
- `data/aseos.json` — generado por el script (no versionado en git; se genera también en el despliegue a GitHub Pages).
