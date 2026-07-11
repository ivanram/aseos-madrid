"""
Construye la base de datos unificada de aseos/servicios de Madrid.

Prioridad de fuentes (de más a menos fiable):
  1. Ayuntamiento de Madrid - "Aseos públicos fijos con publicidad" (oficial, CC BY 4.0)
     https://datos.madrid.es/dataset/300103-0-aseos-publicos-operativos
     -> tipo "aseo_oficial". Siempre gratis, 24h, diseño accesible con cambiador.

  2. Ayuntamiento de Madrid - "Censo de Locales, Actividades y Terrazas" (oficial,
     actualizado a DIARIO, con estado real Abierto/Cerrado/Baja) (CC BY 4.0)
     https://datos.madrid.es/dataset/200085-0-censo-locales
     -> tipo "bar" (bares, cafeterías, tabernas...) y "fastfood" (comida rápida),
        filtrando solo locales con situacion = "Abierto".
     -> tipo "centro_comercial": derivado de las "agrupaciones" de tipo
        "Centro Comercial" que aparecen en el propio censo (no existe un dataset
        dedicado a centros comerciales en el portal).
     Se prefirió este censo a OpenStreetMap para estas categorías porque OSM
     resultó tener bastante desfase (bares que ya no existen, otros que faltan);
     el censo, al ser el registro de licencias del propio Ayuntamiento, tiene
     mucha mejor cobertura y frescura, y trae horario real declarado en ~42% de
     los casos.

  3. OpenStreetMap (vía Overpass API, ODbL) -> tipo "aseo_comunidad": únicamente
     los aseos sueltos (amenity=toilets) no cubiertos por el dataset oficial de
     aseos. Es el único caso donde no hay alternativa oficial.

  4. 2 estaciones de Adif (media/larga distancia) fijadas a mano: Atocha y
     Chamartín. Se excluyen Cercanías y Metro (decisión de producto): el aseo de
     Príncipe Pío, por ejemplo, pertenece en realidad al centro comercial anexo,
     no a la estación.

No requiere dependencias externas (solo librería estándar de Python 3), incluida
la conversión UTM ETRS89 -> lat/lon (validada contra los 130 aseos oficiales que
traen ambos sistemas de coordenadas: error mediana de 4mm).

Uso:
    python scripts/build_data.py
Genera:
    data/aseos.json
"""

import csv
import io
import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

MADRID_BOUNDARY = (
    'area["name"="Madrid"]["boundary"="administrative"]["admin_level"="8"]->.a;'
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
AYTO_ASEOS_API = (
    "https://datos.madrid.es/api/action/package_show?id=300103-0-aseos-publicos-operativos"
)
CENSO_API = (
    "https://datos.madrid.es/api/action/package_show?id=200085-0-censo-locales"
)
CENSO_LOCALES_RESOURCE_ID = "200085-1-censo-locales"     # tiene hora_apertura/cierre
CENSO_ACTIVIDADES_RESOURCE_ID = "200085-5-censo-locales"  # tiene epigrafe + agrupacion

MATCH_THRESHOLD_M = 60  # radio para considerar un aseo de OSM "el mismo" que uno oficial

# Estaciones Adif de media/larga distancia en Madrid capital (fijadas a mano:
# confirmado que Príncipe Pío no cuenta -> el aseo pertenece al centro comercial
# adyacente, no a la estación; Cercanías/Metro excluidos por decisión de producto).
ESTACIONES = [
    {
        "id": "estacion-atocha",
        "nombre": "Madrid-Puerta de Atocha",
        "lat": 40.4056837,
        "lon": -3.6900187,
        "pago": "pago",  # confirmado: aseo de pago (~1€) en la zona pública
    },
    {
        "id": "estacion-chamartin",
        "nombre": "Madrid-Chamartín-Clara Campoamor",
        "lat": 40.4720571,
        "lon": -3.6822622,
        "pago": "pago",  # confirmado: fee=yes en OSM
    },
]

# Epígrafes del censo que consideramos "aseo con consumición, tipo bar" o "fastfood".
# Se excluyen deliberadamente RESTAURANTE (sit-down formal) y todo lo que no sea
# hostelería de acceso rápido (hoteles, comedores de colegio, etc.) - decisión de
# producto tomada explícitamente con el usuario.
EPIGRAFE_A_TIPO = {
    "BAR RESTAURANTE": "bar",
    "BAR CON COCINA": "bar",
    "BAR SIN COCINA": "bar",
    "BAR ESPECIAL SIN ACTUACIONES": "bar",
    "BAR ESPECIAL CON ACTUACIONES": "bar",
    "TABERNA": "bar",
    "CAFETERIA": "bar",
    "CHOCOLATERIA/SALON DE TE Y HELADERIA": "bar",
    "CIBER-CAFE": "bar",
    "RESTAURANTES DE COMIDA RAPIDA": "fastfood",
    "AUTOSERVICIO DE RESTAURACION": "fastfood",
}

CENTRO_COMERCIAL_HORARIO_ESTIMADO = "10:00-22:00"  # horario habitual regulado en España


def _http_get_once(url, data=None, timeout=180):
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": "aseos-madrid-build-script/1.0 (+https://github.com/ivanram/aseos-madrid)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get(url, data=None, timeout=180, retries=4, backoff_s=15):
    """Reintenta con espera creciente ante fallos de red/timeout/errores 5xx —
    en GitHub Actions es habitual que el runner tarde más o que datos.madrid.es
    responda lento bajo carga, y sin reintentos el build fallaba entero."""
    last_err = None
    for attempt in range(retries):
        try:
            return _http_get_once(url, data=data, timeout=timeout)
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            is_http_error = isinstance(e, urllib.error.HTTPError)
            if is_http_error and e.code not in (429, 500, 502, 503, 504):
                raise
            if attempt == retries - 1:
                raise
            wait = backoff_s * (attempt + 1)
            print(f"  Fallo de red ({e}) en {url[:80]}..., reintentando en {wait}s...", file=sys.stderr)
            time.sleep(wait)
    raise last_err


def overpass(query, retries=4, backoff_s=20):
    """La instancia pública de Overpass devuelve 429/504 a menudo bajo carga;
    reintenta con espera creciente antes de rendirse."""
    body = ("data=" + urllib.parse.quote(query)).encode("utf-8")
    return json.loads(http_get(OVERPASS_URL, data=body, timeout=120, retries=retries, backoff_s=backoff_s).decode("utf-8"))["elements"]


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Conversión UTM ETRS89 (huso 30N, el que usa el Ayuntamiento de Madrid) -> lat/lon
# Validada contra los 130 aseos oficiales (que traen ambos sistemas): error
# mediana de 4mm sobre los 130 puntos.
# ---------------------------------------------------------------------------

_UTM_A = 6378137.0
_UTM_F = 1 / 298.257223563
_UTM_K0 = 0.9996
_UTM_E0 = 500000.0
_UTM_LON0 = math.radians(-3)  # huso 30 -> meridiano central -3 grados
_UTM_E2 = _UTM_F * (2 - _UTM_F)
_UTM_EP2 = _UTM_E2 / (1 - _UTM_E2)
_UTM_E1 = (1 - math.sqrt(1 - _UTM_E2)) / (1 + math.sqrt(1 - _UTM_E2))


def utm_to_latlon(x, y):
    M = y / _UTM_K0
    mu = M / (_UTM_A * (1 - _UTM_E2 / 4 - 3 * _UTM_E2 ** 2 / 64 - 5 * _UTM_E2 ** 3 / 256))
    phi1 = (
        mu
        + (3 * _UTM_E1 / 2 - 27 * _UTM_E1 ** 3 / 32) * math.sin(2 * mu)
        + (21 * _UTM_E1 ** 2 / 16 - 55 * _UTM_E1 ** 4 / 32) * math.sin(4 * mu)
        + (151 * _UTM_E1 ** 3 / 96) * math.sin(6 * mu)
        + (1097 * _UTM_E1 ** 4 / 512) * math.sin(8 * mu)
    )
    N1 = _UTM_A / math.sqrt(1 - _UTM_E2 * math.sin(phi1) ** 2)
    T1 = math.tan(phi1) ** 2
    C1 = _UTM_EP2 * math.cos(phi1) ** 2
    R1 = _UTM_A * (1 - _UTM_E2) / (1 - _UTM_E2 * math.sin(phi1) ** 2) ** 1.5
    D = (x - _UTM_E0) / (N1 * _UTM_K0)

    lat = phi1 - (N1 * math.tan(phi1) / R1) * (
        D ** 2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * _UTM_EP2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * _UTM_EP2 - 3 * C1 ** 2) * D ** 6 / 720
    )
    lon = _UTM_LON0 + (
        D
        - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * _UTM_EP2 + 24 * T1 ** 2) * D ** 5 / 120
    ) / math.cos(phi1)

    return math.degrees(lat), math.degrees(lon)


def parse_utm(x_str, y_str):
    try:
        x, y = float(x_str), float(y_str)
    except (TypeError, ValueError):
        return None
    if x == 0 or y == 0:
        return None
    return utm_to_latlon(x, y)


# ---------------------------------------------------------------------------
# 1. Aseos oficiales del Ayuntamiento
# ---------------------------------------------------------------------------

def fetch_ayto_aseos():
    meta = json.loads(http_get(AYTO_ASEOS_API).decode("utf-8"))
    resources = meta["result"]["resources"]
    csv_url = next(r["url"] for r in resources if r["format"] == "CSV")

    raw = http_get(csv_url).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw), delimiter=";")

    records = []
    for row in reader:
        try:
            lat = float(row["LATITUD"])
            lon = float(row["LONGITUD"])
        except (KeyError, ValueError):
            continue

        direccion_partes = [row.get("VIAL", ""), row.get("DIRECCION", ""), row.get("NUMERO", "")]
        direccion = " ".join(p.strip() for p in direccion_partes if p and p.strip())

        records.append({
            "id": "ayto-" + row["CODIGO ASEO"].strip(),
            "tipo": "aseo_oficial",
            "source": "ayuntamiento",
            "lat": lat,
            "lon": lon,
            "nombre": row.get("NOMBRE", "").strip() or direccion,
            "direccion": direccion or None,
            "pago": "gratis",
            "horario": {"modo": "24h", "detalle": None},
            "accesible": True,       # diseño universal de la concesión (todas las cabinas)
            "cambiador": True,       # idem
            "verificado": meta["result"].get("issued"),
        })
    return records, [(r["lat"], r["lon"]) for r in records]


# ---------------------------------------------------------------------------
# 2. Aseos "de comunidad" (OSM, no cubiertos por el dataset oficial)
# ---------------------------------------------------------------------------

def fetch_osm_toilets():
    query = f"""
    [out:json][timeout:60];
    {MADRID_BOUNDARY}
    (
      node["amenity"="toilets"](area.a);
      way["amenity"="toilets"](area.a);
    );
    out center tags;
    """
    return overpass(query)


def yn(tag_value):
    if tag_value is None:
        return None
    v = tag_value.strip().lower()
    if v in ("yes", "designated", "limited"):
        return True
    if v in ("no",):
        return False
    return None


def pago_from_fee(fee_value):
    if fee_value is None:
        return "desconocido"
    v = fee_value.strip().lower()
    if v == "yes":
        return "pago"
    if v == "no":
        return "gratis"
    return "desconocido"


def build_aseo_comunidad(el):
    if el["type"] == "node":
        lat, lon = el.get("lat"), el.get("lon")
    else:
        c = el.get("center", {})
        lat, lon = c.get("lat"), c.get("lon")
    if lat is None:
        return None

    t = el.get("tags", {})
    return {
        "id": f"osm-{el['type']}-{el['id']}",
        "tipo": "aseo_comunidad",
        "source": "osm",
        "lat": lat,
        "lon": lon,
        "nombre": t.get("name") or None,
        "direccion": t.get("addr:street") or None,
        "pago": pago_from_fee(t.get("fee")),
        "horario": (
            {"modo": "conocido", "detalle": t.get("opening_hours")}
            if t.get("opening_hours")
            else {"modo": "desconocido", "detalle": None}
        ),
        "accesible": yn(t.get("wheelchair")),
        "cambiador": yn(t.get("changing_table")),
        "verificado": t.get("check_date"),
    }


# ---------------------------------------------------------------------------
# 3. Censo de locales: bares/fastfood + centros comerciales
# ---------------------------------------------------------------------------

def resolve_censo_urls():
    meta = json.loads(http_get(CENSO_API).decode("utf-8"))
    resources = {r["id"]: r["url"] for r in meta["result"]["resources"]}
    return resources[CENSO_LOCALES_RESOURCE_ID], resources[CENSO_ACTIVIDADES_RESOURCE_ID]


def fecha_iso(fx_carga):
    # fx_carga viene como "DD/MM/YYYY"
    try:
        d, m, y = fx_carga.strip().split("/")
        return f"{y}-{m}-{d}"
    except (AttributeError, ValueError):
        return None


def fetch_horarios_por_local(locales_url):
    """Devuelve {id_local: (apertura1, cierre1, apertura2, cierre2)} solo para
    filas con algún horario declarado (evita cargar en memoria lo que no usamos)."""
    raw = http_get(locales_url).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw), delimiter=";")
    horarios = {}
    for row in reader:
        a1 = row.get("hora_apertura1", "").strip()
        if not a1:
            continue
        horarios[row["id_local"]] = (
            a1,
            row.get("hora_cierre1", "").strip(),
            row.get("hora_apertura2", "").strip(),
            row.get("hora_cierre2", "").strip(),
        )
    return horarios


def to_minutes(hhmm):
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def minutes_to_hhmm(mins):
    mins = int(round(mins)) % 1440
    return f"{mins // 60:02d}:{mins % 60:02d}"


def horario_detalle(apertura1, cierre1, apertura2, cierre2):
    turnos = []
    if apertura1 and cierre1:
        turnos.append(f"{apertura1}-{cierre1}")
    if apertura2 and cierre2 and (apertura2, cierre2) != (apertura1, cierre1):
        turnos.append(f"{apertura2}-{cierre2}")
    return ", ".join(turnos) if turnos else None


def fetch_censo_locales_hosteleria():
    locales_url, actividades_url = resolve_censo_urls()

    print("  Descargando horarios (censo de locales)...", file=sys.stderr)
    horarios = fetch_horarios_por_local(locales_url)
    print(f"  {len(horarios)} locales con horario declarado", file=sys.stderr)

    print("  Descargando actividades (censo)...", file=sys.stderr)
    raw = http_get(actividades_url).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw), delimiter=";")

    bar_fastfood_records = []
    agrupaciones_cc = defaultdict(lambda: {"n": 0, "lat_sum": 0.0, "lon_sum": 0.0, "lat": None, "lon": None})
    seen_ids = set()

    # para estimar horario por categoria cuando no hay dato real
    horas_por_tipo = defaultdict(lambda: {"starts": [], "ends": []})

    for row in reader:
        if row.get("desc_situacion_local", "").strip() != "Abierto":
            continue

        id_local = row.get("id_local", "").strip()
        epigrafe = row.get("desc_epigrafe", "").strip()
        tipo_agrup = row.get("desc_tipo_agrup", "").strip()
        nombre_agrup = row.get("nombre_agrupacion", "").strip()

        # recolectar centros comerciales (agrupaciones), independientemente del epigrafe
        if tipo_agrup == "Centro Comercial" and nombre_agrup:
            cc = agrupaciones_cc[nombre_agrup]
            cc["n"] += 1
            latlon = parse_utm(row.get("coordenada_x_agrupacion"), row.get("coordenada_y_agrupacion"))
            if latlon and cc["lat"] is None:
                cc["lat"], cc["lon"] = latlon
            else:
                latlon_local = parse_utm(row.get("coordenada_x_local"), row.get("coordenada_y_local"))
                if latlon_local:
                    cc["lat_sum"] += latlon_local[0]
                    cc["lon_sum"] += latlon_local[1]

        tipo = EPIGRAFE_A_TIPO.get(epigrafe)
        if tipo is None:
            continue
        if id_local in seen_ids:
            continue
        seen_ids.add(id_local)

        latlon = parse_utm(row.get("coordenada_x_local"), row.get("coordenada_y_local"))
        if latlon is None:
            continue
        lat, lon = latlon

        direccion_partes = [row.get("desc_vial_edificio", ""), row.get("num_edificio", "")]
        direccion = " ".join(p.strip() for p in direccion_partes if p and p.strip()) or None

        rotulo = row.get("rotulo", "").strip()
        nombre = None if rotulo in ("", "S/R") else rotulo

        agrupacion = {"nombre": nombre_agrup, "tipo": tipo_agrup} if (nombre_agrup or tipo_agrup) else None

        h = horarios.get(id_local)
        if h:
            detalle = horario_detalle(*h)
            horario = {"modo": "conocido", "detalle": detalle} if detalle else {"modo": "desconocido", "detalle": None}
            if detalle:
                s = to_minutes(h[0])
                e = to_minutes(h[1])
                if s is not None and e is not None:
                    if e <= s:
                        e += 1440
                    horas_por_tipo[tipo]["starts"].append(s)
                    horas_por_tipo[tipo]["ends"].append(e)
        else:
            horario = {"modo": "desconocido", "detalle": None}  # se completa despues con la estimacion

        bar_fastfood_records.append({
            "id": "censo-" + id_local,
            "tipo": tipo,
            "source": "ayuntamiento",
            "lat": lat,
            "lon": lon,
            "nombre": nombre,
            "direccion": direccion,
            "pago": "consumicion",
            "horario": horario,
            "agrupacion": agrupacion,
            "verificado": fecha_iso(row.get("fx_carga", "")),
        })

    # estimaciones de horario por categoria, calculadas a partir del propio censo
    estimaciones = {}
    for tipo, vals in horas_por_tipo.items():
        if vals["starts"]:
            s = statistics.median(vals["starts"])
            e = statistics.median(vals["ends"])
            estimaciones[tipo] = f"{minutes_to_hhmm(s)}-{minutes_to_hhmm(e)}"

    # aplicar la estimacion a los que no tenian horario propio
    for rec in bar_fastfood_records:
        if rec["horario"]["modo"] == "desconocido" and estimaciones.get(rec["tipo"]):
            rec["horario"] = {"modo": "estimado_categoria", "detalle": estimaciones[rec["tipo"]]}

    # construir los registros de centro_comercial a partir de las agrupaciones
    centro_comercial_records = []
    for nombre_agrup, cc in agrupaciones_cc.items():
        lat, lon = cc["lat"], cc["lon"]
        if lat is None and cc["n"] > 0 and cc["lat_sum"]:
            lat, lon = cc["lat_sum"] / cc["n"], cc["lon_sum"] / cc["n"]
        if lat is None:
            continue
        centro_comercial_records.append({
            "id": "censo-agrupacion-" + nombre_agrup.lower().replace(" ", "-"),
            "tipo": "centro_comercial",
            "source": "ayuntamiento",
            "lat": lat,
            "lon": lon,
            "nombre": nombre_agrup.title(),
            "direccion": None,
            "pago": "gratis",
            "horario": {"modo": "estimado_categoria", "detalle": CENTRO_COMERCIAL_HORARIO_ESTIMADO},
            "agrupacion": None,
            "verificado": None,
        })

    return bar_fastfood_records, centro_comercial_records, estimaciones


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    print("Descargando aseos oficiales (Ayuntamiento)...", file=sys.stderr)
    ayto_records, ayto_coords = fetch_ayto_aseos()
    print(f"  {len(ayto_records)} aseos oficiales", file=sys.stderr)

    print("Descargando aseos de OSM (solo aseo_comunidad)...", file=sys.stderr)
    osm_toilet_elements = fetch_osm_toilets()
    comunidad_records = []
    for el in osm_toilet_elements:
        rec = build_aseo_comunidad(el)
        if rec is None:
            continue
        is_duplicate = any(
            haversine(rec["lat"], rec["lon"], a_lat, a_lon) <= MATCH_THRESHOLD_M
            for a_lat, a_lon in ayto_coords
        )
        if not is_duplicate:
            comunidad_records.append(rec)
    print(f"  {len(osm_toilet_elements)} en OSM -> {len(comunidad_records)} no duplicados con el oficial", file=sys.stderr)

    print("Descargando censo de locales (bar/fastfood/centro comercial)...", file=sys.stderr)
    bar_fastfood_records, centro_comercial_records, estimaciones = fetch_censo_locales_hosteleria()
    n_bar = sum(1 for r in bar_fastfood_records if r["tipo"] == "bar")
    n_fastfood = sum(1 for r in bar_fastfood_records if r["tipo"] == "fastfood")
    print(f"  {n_bar} bar/cafeteria, {n_fastfood} fastfood, {len(centro_comercial_records)} centros comerciales", file=sys.stderr)
    print(f"  Horarios estimados por categoria (del propio censo): {estimaciones}", file=sys.stderr)

    estacion_records = []
    for e in ESTACIONES:
        estacion_records.append({
            "id": e["id"],
            "tipo": "estacion",
            "source": "manual",
            "lat": e["lat"],
            "lon": e["lon"],
            "nombre": e["nombre"],
            "direccion": None,
            "pago": e["pago"],
            "horario": {"modo": "desconocido", "detalle": None},
            "verificado": None,
        })

    all_records = ayto_records + comunidad_records + bar_fastfood_records + centro_comercial_records + estacion_records

    output = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "fuentes": {
            "ayuntamiento_aseos": "https://datos.madrid.es/dataset/300103-0-aseos-publicos-operativos (CC BY 4.0)",
            "ayuntamiento_censo": "https://datos.madrid.es/dataset/200085-0-censo-locales (CC BY 4.0)",
            "osm": "https://www.openstreetmap.org/copyright (ODbL) via Overpass API",
        },
        "conteos": {
            "aseo_oficial": len(ayto_records),
            "aseo_comunidad": len(comunidad_records),
            "bar": n_bar,
            "fastfood": n_fastfood,
            "centro_comercial": len(centro_comercial_records),
            "estacion": len(estacion_records),
            "total": len(all_records),
        },
        "estimaciones_horario_por_categoria": estimaciones,
        "lugares": all_records,
    }

    with open("data/aseos.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print("\nListo. data/aseos.json generado.", file=sys.stderr)
    print(json.dumps(output["conteos"], indent=2, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
