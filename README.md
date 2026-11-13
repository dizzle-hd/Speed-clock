<p align="center"><img src="assets/logo.svg" width="96" alt="Speed Clock Logo"></p>

# Speed Clock

Online-Stoppuhr für blitzschnelle Runden – läuft komplett im Browser und wird automatisch über GitHub Actions auf GitHub Pages veröffentlicht.

## Funktionen
- **Schnelle Runden:** Leertaste, großer „RUNDE“-Button oder auf die Zeitanzeige tippen
- **Auto-Runden** bis hinunter auf **1 µs (0,000001 s)** – Milliarden Runden ohne Absturz, weil Runden berechnet statt einzeln gespeichert werden
- **Admin-Panel** (Regler-Symbol, Taste `S` oder `#admin` in der URL):
  - Runden: Intervall (µs/ms/s/min), Auto beim Start, Stopp nach N Runden, Doppel-Tipp-Sperre
  - Zeit: Dauer der Stoppuhr (stoppt exakt), Startverzögerung 3/5/10 s
  - Anzeige: Design hell/dunkel, Akzentfarbe, Nachkommastellen, Zeilen der Rundenliste
  - Feedback: Ton + Lautstärke, Vibration, Bildschirm wach halten
  - Daten: Live-Statistik, CSV-Export (in Etappen, bis 1 Mio. Zeilen), Einstellungen exportieren/importieren
  - Sicherheit: optionaler Admin-PIN (lokal, gehasht)
- **Sitzung wird gesichert:** Nach Neuladen oder Absturz des Tabs läuft die Uhr korrekt weiter

## Tastatur
| Taste | Aktion |
|---|---|
| `Leertaste` / `L` | Runde (startet, wenn gestoppt) |
| `Enter` | Start / Stopp |
| `A` | Auto-Runden an/aus |
| `R` | Reset |
| `S` | Admin-Panel |

## Deployment
`.github/workflows/pages.yml` veröffentlicht `index.html` und `assets/` bei jedem Push.
Einmalig nötig: **Settings → Pages → Source: „GitHub Actions“**.
