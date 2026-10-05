# LEGO-Teilefinder

Private Web-App (PWA) fürs iPad: Auf einem Foto mit 100–300 LEGO-Teilen werden
gesuchte Teile inklusive Farbe gefunden und im Bild markiert.
Reines HTML/CSS/JavaScript, kein Build-Schritt, keine eigene Server-Logik.

**Adresse:** https://joergl-s.github.io/lego-teilefinder/

## So funktioniert es

1. **Suchliste**: Teile per Text (Nummer oder englischer Name, z. B. `3001`, `brick 2x4`)
   oder per Beispielfoto (Brickognize) suchen, Farbe wählen (oder „Farbe egal“), optional Menge.
2. **Foto**: Kamera oder Fotomediathek. Originalauflösung bleibt erhalten
   (Safari-Grenze: max. ca. 16 MP, größere Fotos werden verkleinert).
3. **Analyse**
   - *Stufe A, lokal*: Hintergrund schätzen, Teile segmentieren (OpenCV.js im Web Worker),
     berührende Teile trennen (Distance-Transform + Watershed, zusätzlich nach Farbe),
     Farbe je Teil messen (Lab-Median, CIEDE2000 gegen Rebrickable-Farben), Vorfilter nach Farbe.
   - *Stufe B, Brickognize*: Nur die vorgefilterten Ausschnitte werden erkannt
     (parallel, mit Wiederholung, Cache, Abbrechen).
4. **Ergebnis**: Grün = sicher, Gelb = unsicher. Zoomen/Verschieben mit den Fingern,
   Box antippen → Kandidaten + Korrektur, Trefferliste, „Manuell“ markieren, PNG-Export.

Debug-Ansicht (abschaltbar): Konturen, Maske, Messwerte, Farbtabelle.

## Einrichtung (einmalig)

1. **GitHub Pages einschalten**: Repo → *Settings* → *Pages* → *Source: Deploy from a branch*
   → Branch `main`, Ordner `/ (root)` → *Save*. Nach 1–2 Minuten ist die App unter der Adresse oben erreichbar.
2. **Teiledaten laden**: Repo → *Actions* → „Teiledaten aktualisieren“ → *Run workflow*.
   Die Action lädt die Rebrickable-Tabellen nach `data/` und committet sie (danach monatlich automatisch).
   Falls die Action scheitert: CSV-Dateien selbst von https://rebrickable.com/downloads/ laden und
   in der App unter *Einstellungen → Dateien importieren* auswählen.
3. **Aufs iPad**: Adresse in Safari öffnen → Teilen-Symbol → *Zum Home-Bildschirm*.
   Als Home-Bildschirm-App bleiben Daten dauerhaft erhalten und die App startet offline.
4. **Brickognize testen**: *Einstellungen → Verbindung testen*. Bei „nicht erreichbar/CORS“
   den Proxy einrichten: siehe [`proxy/README.md`](proxy/README.md).

## Aufbau

```
index.html              Oberfläche (4 Schritte, Dialoge)
manifest.webmanifest    PWA-Manifest
sw.js                   Service Worker (App-Shell + OpenCV offline)
css/app.css
js/ui.js                Oberfläche und Ablauf
js/settings.js          Einstellungen + Suchliste (localStorage)
js/db.js                IndexedDB (Teiledaten, Erkennungs-Cache)
js/data.js              Rebrickable-CSVs laden/parsen/importieren
js/search.js            Suchindex, Variantenfamilien (part_relationships)
js/image.js             Foto laden (EXIF), Arbeitskopien, Ausschnitte, Masken
js/segment.js           Steuerung der Segmentierung, Kachel-Modus
js/segment-worker.js    Segmentierung im Web Worker (OpenCV.js)
js/color.js             Lab, CIEDE2000, Farbmessung, Weißabgleich
js/recognize.js         Brickognize-API (Queue, Retry, Cache)
js/match.js             Abgleich Teil/Farbe ↔ Suchliste, Zähler
js/overlay.js           Zoombare Bildansicht mit Boxen, Export-Zeichnung
vendor/opencv.js        OpenCV.js 4.10 (@techstark/opencv-js, Apache-2.0)
data/                   Rebrickable-Daten (von der Action geschrieben)
tools/update-data.sh    Daten-Update-Skript
proxy/                  Optionaler Cloudflare-Worker als CORS-Proxy
```

## Hinweise für Änderungen

- Nach jeder Änderung an App-Dateien `CACHE_VERSION` in `sw.js` erhöhen, sonst sieht das iPad
  die neue Version nicht. Die App zeigt dann „Neue Version verfügbar – Jetzt neu laden“.
- Keine Secrets im Code. Einstellungen und Suchliste liegen nur im Browser.
- Fotos verlassen das Gerät nur als kleine Ausschnitte (≤ 512 px) an Brickognize bzw. den Proxy.

## Bekannte Grenzen

- Überlappende/gestapelte Teile werden schlecht getrennt → „Manuell“ oder Kachel-Modus.
- Gleichfarbige Teile, die bündig aneinanderliegen, verschmelzen oft (gestrichelte Box „evtl. mehrere Teile“).
- Ähnliche Farben (Schwarz/Dunkelgrau, Hellgrau/Hellblaugrau, Rot/Dunkelrot) werden verwechselt → Alternativen werden angezeigt.
- Weiße/helle Teile auf hellem Hintergrund sind schwer zu erkennen → dunklen Untergrund nehmen.
- Brickognize liefert BrickLink-Nummern; die Zuordnung zu Rebrickable-Nummern ist meist, aber nicht immer eindeutig.
- Ergebnisse sind Wahrscheinlichkeiten, keine Gewissheit.

Daten: [Rebrickable](https://rebrickable.com/downloads/) · Erkennung: [Brickognize](https://brickognize.com)
