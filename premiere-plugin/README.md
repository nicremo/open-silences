# Open Silences

Lokales Stillenschneiden in Premiere Pro. Das Panel spricht Englisch, Spanisch und Deutsch. Beim ersten Öffnen wählst du die Sprache, danach lässt sie sich jederzeit über das Globus-Menü oben ändern. Die Texte unten nennen die deutschen Bezeichnungen. Die Oberfläche hat zwei Schritte:

1. Ganze Timeline, In/Out oder ausgewählte Clips wählen. Die Audiospuren mit Sprache markieren.
2. Noise Floor und Schnitttempo einstellen. Auf **Stillen entfernen** klicken.

Das Preset **Standard** verwendet **-45 dB** und viermal **160 ms**. Änderungen bleiben lokal gespeichert. Die anderen Tempi sind eigene Open-Silences-Presets.

## Was beim Schneiden passiert

Zuerst wird eine native Sequenzkopie im Projektordner **Open Silences Backups** erstellt, eindeutig identifiziert und mit der aktiven Sequenz verglichen. Anschließend rendert Premiere die gewählten Audiospuren auf einer separaten Analysekopie. Die Rust-Engine liest das PCM-Audio direkt, erkennt Stillen und plant Grenzen in exakten Premiere-Ticks. Danach zeigt das Panel, wie viele Pausen gefunden wurden und wie viel Zeit entfällt. Geschnitten wird erst nach Klick auf **Jetzt schneiden**. **Nicht schneiden** lässt die Sequenz unverändert, das Backup bleibt im Projekt. Ein erneuter Export prüft den aktuellen Audiomix vor dem Schnitt.

Geschnitten wird die ursprüngliche aktive Sequenz. Das Backup bleibt erhalten. Bild und alle betroffenen Tonspuren rücken zusammen. Nach dem Eingriff werden alle Clippositionen, Quellbereiche, Medienzuordnungen und das unveränderte Backup geprüft. Bei unerwartetem Zustand gibt es keinen weiteren Schnitt und keine Erfolgsmeldung. Ein bereits begonnener Eingriff wird nicht automatisch zurückgerollt. In diesem Fall steht das benannte Backup zum Wiederherstellen bereit.

Analysekopien liegen getrennt unter **Open Silences Analysis**. Audioexport und nativer Schnitt blockieren zeitweise Premiere und sind nicht abbrechbar. Die Rust-Analyse ist abbrechbar. Laufbelege inklusive WAV-Dateien bleiben im temporären Ordner `open-silences-evidence` erhalten.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| Noise Floor (`thresholdDb`) | Audio unter diesem Pegel gilt als Stille. Größere Werte entfernen eher leise Passagen. |
| Stillen ab (`minPause`) | Pausen ab dieser Dauer werden entfernt. Kürzere Pausen bleiben erhalten. |
| Sprache ab (`minSpeech`) | Kürzere und leise Geräusche zählen nicht als Sprache. Kurze laute Wörter bleiben. |
| Luft vor Sprache (`leadIn`) | Audio vor dem nächsten Sprachstück, das erhalten bleibt. |
| Luft nach Sprache (`tail`) | Audio nach dem vorigen Sprachstück, das erhalten bleibt. |

Bildmaterial ohne Dialogclip (B-Roll) wird nie entfernt. Schnitte unter 100 ms werden übersprungen. Die vollständige Erkennung steht in `docs/DETECTION.md`.

**Pegel automatisch schätzen** berechnet lokal einen vorsichtigen Vorschlag aus ruhigen und lauten Abschnitten des gewählten Bereichs. Das ist eine statistische Schätzung, keine Cloudfunktion. Bei gleichförmigem oder ausschließlich stillem Audio wird kein Wert erfunden. Der Vorschlag lässt sich manuell ändern.

In/Out müssen tatsächlich in Premiere gesetzt sein. Bei ausgewählten Clips werden deren Zeitbereiche vereinigt. Lücken zwischen getrennten Bereichen werden nicht bearbeitet. Ripple verschiebt nachfolgende Clips entsprechend der entfernten Dauer.

## Geprüfter Umfang

macOS arm64, Premiere Pro **26.5.2**, **25 und 59,94 fps**. Eigene 12-Sekunden-Farbtafeln mit Stereo-Ton und zwei bekannten Stillen bilden die Hosttests. Alle drei Bereichsarten, bestehende Schnittgrenzen und mehrere Tonspuren wurden im echten Host geprüft. Frame-Rundung erfolgt nach innen, damit Schnitte nicht über den gewählten Bereich hinausreichen. Die Abnahme des installierten Panels in Premiere Pro steht noch aus.

Andere Premiere-Versionen, Windows und andere Bildraten sind nicht freigegeben. Gesperrter Content, fehlende Medien, Übergänge und ungeeignete Timeline-Zustände können den Schnitt stoppen. QE ist eine undokumentierte Adobe-Schnittstelle. Die Nachprüfung schützt den unterstützten Ablauf, sie ist keine Garantie für beliebige komplexe Projekte. Eine einzelne Undo-Gruppe wird nicht zugesagt.

## Bauen und installieren

```bash
premiere-plugin/install/install.sh
```

Das Skript baut mit `cargo build --release --locked` und erstellt `premiere-plugin/dist/open-silences/`. Es installiert nichts und ändert keine Systemeinstellung. Für die native Analyse sind ffmpeg und ffprobe nicht erforderlich.

Den erzeugten Ordner in den eigenen CEP-Erweiterungsordner kopieren:

```bash
cp -R premiere-plugin/dist/open-silences "$HOME/Library/Application Support/Adobe/CEP/extensions/"
```

Premiere öffnen. **Fenster > Erweiterungen > Open Silences (Alpha)**. Zum Aktualisieren das Panel schließen und erneut öffnen. Eine unsignierte Entwicklungsfassung braucht einen bereits aktivierten CEP-Entwicklermodus. Das Paket aktiviert ihn nicht selbst.

## Prüfungen

```bash
cargo test --release --locked --manifest-path premiere-plugin/engine/Cargo.toml
cargo fmt --check --manifest-path premiere-plugin/engine/Cargo.toml
cargo clippy --locked --all-targets --manifest-path premiere-plugin/engine/Cargo.toml -- -D warnings
node --test premiere-plugin/test/*.test.mjs
```

Die Runtime-Dateien werden ausdrücklich aufgelistet. Fremde Decoder und lokale Messungen gehören nicht ins Paket. `CSInterface.js` und die beigefügte Adobe-Lizenz sind bytegleich mit den offiziellen Adobe-CEP-Resources-Dateien. Herkunft und Prüfsummen stehen in `panel/js/CSInterface.NOTICE.md`. Der eigene Code steht unter der MIT-Lizenz, siehe `LICENSE`.
