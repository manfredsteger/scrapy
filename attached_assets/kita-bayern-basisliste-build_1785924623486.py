#!/usr/bin/env python3
"""Baut die kanonische Basisliste kita-bayern.de aus den 35 Kreis-Abfragen."""
import re, glob, os, html, json, csv, collections

SRC = "https://www.kita-bayern.de"
EVID = (SRC + "/cgi-bin/redaktion/suche_merkliste.pl"
        "?_Aktion=Suche&_Maske=_suche_allgemein&kreis={k}&_sort=strasse")
OBSERVED = "2026-08-05"

# Quellen-Rubrik. NICHT die Kitamap-Landkreiszuordnung - die entsteht raeumlich
# ueber die Koordinaten. Dient nur der Nachvollziehbarkeit der Herkunft.
KREIS = {
 "a":"Augsburg","ab":"Aschaffenburg","ab-l":"Landkreis Aschaffenburg",
 "an":"Ansbach","ba-l":"Landkreis Bamberg","bt":"Bayreuth",
 "bt-l":"Landkreis Bayreuth","don":"Donau-Ries","er":"Erlangen",
 "erh":"Erlangen-Höchstadt","ffb":"Fürstenfeldbruck","fo":"Forchheim",
 "fs":"Freising","fue":"Fürth","fue-l":"Landkreis Fürth","ho":"Hof",
 "in":"Ingolstadt","ku":"Kulmbach","lau":"Nürnberger Land",
 "ll":"Landsberg am Lech","m":"München","m-l":"Landkreis München",
 "mb":"Miesbach","n":"Nürnberg","nm":"Neumarkt i.d.OPf.",
 "paf":"Pfaffenhofen a.d.Ilm","r":"Regensburg","rh":"Roth","sc":"Schwabach",
 "sr":"Straubing","sr-l":"Straubing-Bogen","sta":"Starnberg",
 "toel":"Bad Tölz-Wolfratshausen","wue":"Würzburg","wug":"Weißenburg-Gunzenhausen",
}
# Codes ohne -l-Gegenstueck, bei denen Stadt/Landkreis aus dem Code nicht
# hervorgeht. Der echte Ort steht ohnehin pro Eintrag in der Adresse.
AMBIG = {"fo","ho","ku","r","don","rh","sta","toel","wug","erh","mb","lau","ll","fs","paf"}


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()


def split_street(addr):
    """'Albert-Einstein-Ring 53' -> ('Albert-Einstein-Ring', '53')"""
    m = re.match(r"^(.*?)[\s,]+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?)$", addr.strip())
    if not m:
        return addr.strip(), ""
    return m.group(1).strip(" ,"), re.sub(r"\s+", "", m.group(2))


# Platzhalter der Quelle, die keine Telefonnummer sind
PLACEHOLDER = re.compile(r"^\s*(k\.\s*A\.?|-+|n\.\s*n\.?|siehe\s+website)\s*$", re.I)


# Eine Nummer: beginnt mit '(' oder Ziffer, danach Ziffern/Trennzeichen.
NUM = re.compile(r"\(?\d[\d\s/()\-]{4,}\d")


def split_number(s):
    """'(09 21) 51 37 30' / '0921/990090' / '0921-745416' -> '0921 51373 0'-Form.
    Die Vorwahl steht in dieser Quelle immer vor '(' , '/' oder '-'."""
    m = re.search(r"\((.*?)\)\s*(.*)$", s)
    if m:
        area, rest = m.group(1), m.group(2)
    elif "/" in s:
        area, rest = s.split("/", 1)
    elif "-" in s:
        area, rest = s.split("-", 1)
    elif re.match(r"^\s*0[\d\s]*?\d\s+\d", s):
        area, rest = re.split(r"\s+", s.strip(), maxsplit=1)
    else:
        return re.sub(r"\D", "", s)
    a, b = re.sub(r"\D", "", area), re.sub(r"\D", "", rest)
    return (a + " " + b).strip() if a and b else re.sub(r"\D", "", s)


def extract_phones(raw):
    """-> [{'number': ..., 'info': ...}]. Eine Zelle kann mehrere beschriftete
    Nummern enthalten ('Büro: 0921-745, Krippe: 0921-746')."""
    if not raw or PLACEHOLDER.match(raw):
        return []
    out, pos = [], 0
    for m in NUM.finditer(raw):
        if len(re.sub(r"\D", "", m.group(0))) < 6:
            continue
        label = raw[pos:m.start()].strip(" :,;.- ")
        pos = m.end()
        num = split_number(m.group(0))
        if not num:
            continue
        # 'oder'/'bzw.'/'und' ist kein Label, sondern eine Aufzaehlung: die
        # Folgenummer teilt sich die Vorwahl der vorherigen.
        if re.fullmatch(r"(oder|bzw\.?|und|u\.|sowie)", label, re.I):
            label = ""
        if out and " " not in num and not num.startswith("0"):
            area = out[-1]["number"].split(" ")[0]
            if area:
                num = area + " " + num
        if any(p["number"] == num for p in out):
            continue
        out.append({"number": num[:32], "info": label[:32]})
    return out


rows, warnings = [], []
mojibake = 0

for f in sorted(glob.glob("allg/*.html")):
    k = os.path.basename(f)[:-5]
    raw = open(f, "rb").read().decode("iso-8859-1")
    if "Ã¤" in raw or "Ã¼" in raw:
        mojibake += 1

    # 1) JS-Marker: vollstaendige Adresse + Koordinaten, Schluessel = link
    markers = {}
    for txt, link, lat, lon, nm in re.findall(
        r"var text = '(.*?)';\s*var link = '(.*?)';\s*"
        r"showFrontendMarker\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*'(.*?)'", raw, re.S):
        slug = re.sub(r"^/\./|/index\.html$", "", link)
        markers[slug] = (txt, float(lat), float(lon))

    # 2) Tabellenzeilen: Telefon, Traeger, Altersgruppen
    # Achtung: Whitespace im <tr> variiert je nach _Maske -> tolerant matchen
    for tr in re.findall(r'<tr[^>]*\bdata-latlon="[^"]*"[^>]*>.*?</tr>', raw, re.S):
        link = re.search(r'href="/\./([^"]+?)/index\.html"', tr)
        if not link:
            continue
        slug = link.group(1)
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        smalls = re.findall(r"<small>(.*?)</small>", tds[0], re.S) if tds else []
        name = re.search(r'target="_blank">(.*?)</a>', tr, re.S)
        trg = re.search(r"Tr&auml;ger:\s*(.*?)<br", tr, re.S)

        txt, lat, lon = markers.get(slug, (None, None, None))
        if lat is None:
            # Fallback: Koordinaten stehen auch am <tr> selbst.
            # ACHTUNG: '-' ist Trennzeichen, kein Vorzeichen.
            mll = re.search(r'data-latlon="latlon-(\d+\.\d+)-(\d+\.\d+)"', tr)
            if mll:
                lat, lon = float(mll.group(1)), float(mll.group(2))
        street = number = zipc = city = ""
        if txt:
            # 'Albert-Einstein-Ring 53, 95448 Bayreuth'
            m = re.match(r"^(.*),\s*(\d{5})\s+(.*)$", clean(txt))
            if m:
                street, number = split_street(m.group(1))
                zipc, city = m.group(2), m.group(3).strip()
            else:
                street, number = split_street(clean(txt))
                warnings.append(f"{slug}: Adresse ohne PLZ/Ort -> {clean(txt)!r}")
        else:
            addr = clean(smalls[0]) if smalls else ""
            street, number = split_street(addr)
            warnings.append(f"{slug}: kein JS-Marker (keine PLZ/Ort/Koordinaten)")

        praw = clean(smalls[1]) if len(smalls) > 1 else ""
        phones = extract_phones(praw)
        if len(phones) > 5:
            warnings.append(f"{slug}: {len(phones)} Nummern, nur 5 Slots -> Rest verworfen")
        # Direkt auf die Kitamap-Slots phone/phone2..5 + phoneInfo/-2..5 legen
        pslots = {}
        for i, p in enumerate(phones[:5], start=1):
            sfx = "" if i == 1 else str(i)
            pslots[f"phone{sfx}"] = p["number"]
            pslots[f"phoneInfo{sfx}"] = p["info"]
        for i in range(1, 6):
            sfx = "" if i == 1 else str(i)
            pslots.setdefault(f"phone{sfx}", "")
            pslots.setdefault(f"phoneInfo{sfx}", "")
        if lat is not None and not (47.2 <= lat <= 50.6 and 8.9 <= lon <= 13.9):
            warnings.append(f"{slug}: Koordinate ausserhalb Bayern ({lat}, {lon})")

        rows.append({
            "sourceSlug": slug,
            "sourceUrl": f"{SRC}/{slug}/index.html",
            "kreisCode": k,
            "kreisLabel": KREIS.get(k, k),
            "kreisLabelAmbiguous": k in AMBIG,
            "name": clean(name.group(1)) if name else "",
            "traeger": clean(trg.group(1)) if trg else "",
            "street": street,
            "streetNumber": number,
            "zipCode": zipc,
            "city": city,
            "latitude": lat,
            "longitude": lon,
            "phoneRaw": praw,
            **pslots,
            "ageU3": {"Ja": True, "Nein": False}.get(clean(tds[2]) if len(tds) > 2 else ""),
            "age3to6": {"Ja": True, "Nein": False}.get(clean(tds[3]) if len(tds) > 3 else ""),
            "ageSchool": {"Ja": True, "Nein": False}.get(clean(tds[4]) if len(tds) > 4 else ""),
            "observedAt": OBSERVED,
            "evidenceUrl": EVID.format(k=k),
        })

# Dedup ueber sourceSlug (http/https-Doppel aus dem alten Crawl gibt es hier nicht,
# aber die Invariante wird trotzdem geprueft)
seen, uniq = set(), []
for r in rows:
    if r["sourceSlug"] in seen:
        warnings.append(f"{r['sourceSlug']}: Duplikat verworfen")
        continue
    seen.add(r["sourceSlug"])
    uniq.append(r)
rows = uniq

out = "/Users/manfredsteger/Downloads"
json.dump({"source": "import:kita-bayern", "observedAt": OBSERVED,
           "endpoint": EVID.format(k="<KREIS>"), "count": len(rows),
           "locations": rows},
          open(f"{out}/kita-bayern-basisliste.json", "w"),
          ensure_ascii=False, indent=1)

cols = list(rows[0].keys())
with open(f"{out}/kita-bayern-basisliste.csv", "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.DictWriter(fh, fieldnames=cols, delimiter=";")
    w.writeheader()
    w.writerows(rows)

n = len(rows)
print(f"Einrichtungen: {n}")
print(f"Latin-1-Dateien mit UTF-8-Resten: {mojibake}")
for c in ("name", "traeger", "street", "zipCode", "city", "latitude", "phone"):
    v = sum(1 for r in rows if r[c] not in ("", None))
    print(f"  {c:12s} {v:4d}  ({100*v/n:5.1f}%)")
print(f"  {'Hausnummer':12s} {sum(1 for r in rows if r['streetNumber']):4d}")
print(f"\nOrte: {len(set(r['city'] for r in rows if r['city']))} | "
      f"PLZ: {len(set(r['zipCode'] for r in rows if r['zipCode']))}")
dups = [c for c, n_ in collections.Counter(
    (r["latitude"], r["longitude"]) for r in rows if r["latitude"]).items() if n_ > 1]
print(f"Mehrfach belegte Koordinaten: {len(dups)}")
print(f"\nWarnungen: {len(warnings)}")
for w_ in warnings[:15]:
    print("  -", w_)
