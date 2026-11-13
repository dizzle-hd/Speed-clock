# ⏱ Speed Clock

Online-Stoppuhr für schnelle Runden – läuft komplett im Browser und wird automatisch über GitHub Actions auf GitHub Pages veröffentlicht.

## Funktionen
- **Blitzschnelle Runden:** Leertaste, großer „Runde“-Button oder einfach auf die Zeitanzeige tippen
- **Auto-Runden:** automatisch alle X Minuten/Sekunden eine Runde
- **Countdown:** Zeit einstellen (mit Presets), Alarm bei 0
- **Auto-Stopp** nach einer festgelegten Rundenanzahl
- Beste / langsamste Runde markiert, Schnitt, Differenz zur Vorrunde
- Export als CSV oder in die Zwischenablage (für Excel)
- Ton, Vibration, Bildschirm-wach-halten; Einstellungen werden gespeichert

## Tastatur
| Taste | Aktion |
|---|---|
| `Leertaste` / `L` | Runde (startet, wenn gestoppt) |
| `Enter` | Start / Stopp |
| `R` | Reset |

## Deployment
Der Workflow `.github/workflows/pages.yml` veröffentlicht die Seite bei jedem Push.
Einmalig nötig: **Settings → Pages → Build and deployment → Source: „GitHub Actions“**.
