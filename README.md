# ⏱ Speed Clock

Online-Stoppuhr für schnelle Runden – läuft komplett im Browser und wird automatisch über GitHub Actions auf GitHub Pages veröffentlicht.

## Funktionen
- **Eine Stoppuhr** mit blitzschnellen Runden: Leertaste, großer „Runde“-Button oder auf die Zeitanzeige tippen
- **Auto-Runden-Button:** automatisch alle X Sekunden eine Runde – bis hinunter auf **0,000001 s** (Millionen Runden pro Sekunde, ohne Absturz: die Runden werden berechnet statt einzeln gespeichert)
- **Dauer einstellbar** (h / min / s, 0 = unbegrenzt): die Stoppuhr stoppt automatisch, mit Restzeit und Fortschrittsbalken
- Rundenliste mit Live-Ansicht, Blättern und „Gehe zu Runde #“ – auch bei Millionen Runden flüssig
- Beste / langsamste Runde, Schnitt; Export als CSV (max. 1 Mio. Zeilen) oder Zwischenablage (max. 100.000)
- Ton, Vibration, Bildschirm-wach-halten; Einstellungen werden gespeichert

## Tastatur
| Taste | Aktion |
|---|---|
| `Leertaste` / `L` | Runde (startet, wenn gestoppt) |
| `Enter` | Start / Stopp |
| `A` | Auto-Runden an/aus |
| `R` | Reset |

## Deployment
Der Workflow `.github/workflows/pages.yml` veröffentlicht die Seite bei jedem Push.
Einmalig nötig: **Settings → Pages → Build and deployment → Source: „GitHub Actions“**.
