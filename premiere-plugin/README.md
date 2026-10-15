# Open Silences

Lokales Stillenschneiden in Premiere Pro. Das Panel spricht Englisch, Spanisch und Deutsch. Beim ersten Öffnen wählst du die Sprache, danach lässt sie sich jederzeit über das Globus-Menü oben ändern. Die Texte unten nennen die deutschen Bezeichnungen. Die Oberfläche hat zwei Schritte:

1. Ganze Timeline, In/Out oder ausgewählte Clips wählen. Die Audiospuren mit Sprache markieren.
2. Noise Floor und Schnitttempo einstellen. Auf **Stillen entfernen** klicken.

Das Preset **Standard** verwendet **-45 dB** und viermal **160 ms**. Änderungen bleiben lokal gespeichert. Die anderen Tempi setzen alle vier Zeiten auf denselben Wert: 500, 350, 200, 100 oder 50 ms.

## Was beim Schneiden passiert

Ist **Backup vor dem Schnitt** eingeschaltet (Standard), wird zuerst eine native Sequenzkopie im Projektordner **Open Silences Backups** erstellt, eindeutig identifiziert und mit der aktiven Sequenz verglichen. Anschließend rendert Premiere die gewählten Audiospuren als Mono-WAV mit 32-Bit-Float in der Abtastrate der Sequenz, ohne Resampling-Filter. Die Engine misst die Pegel bei 16 kHz an jedem n-ten Sample. Die übrigen Audiospuren sind dafür kurz stummgeschaltet und werden danach wiederhergestellt, auch nach einem Fehler. Lehnt Premiere diese Exportvorgabe ab, rendert die eigene 48-kHz-Vorgabe von Premiere. Die Rust-Engine liest das PCM-Audio direkt, erkennt Stillen und plant Grenzen in exakten Premiere-Ticks. Danach zeigt das Panel, wie viele Pausen gefunden wurden und wie viel Zeit entfällt. Geschnitten wird erst nach Klick auf **Jetzt schneiden**. **Nicht schneiden** lässt die Sequenz unverändert. Auf Wunsch prüft ein erneuter Export den Audiomix direkt vor dem Schnitt.

Geschnitten wird die ursprüngliche aktive Sequenz, in Paketen zu 50 Schnitten vom Ende der Timeline zum Anfang. Während eines Pakets zeigt die Sequenz Frames statt Timecode, deshalb lässt sich jede Bildrate schneiden. Jeder Schnitt ist ein Extrahieren zwischen In- und Out-Punkt auf allen nicht gesperrten Spuren, so rücken Bild und Ton gemeinsam zusammen, auch über Clipgrenzen hinweg. Anzeigeformat, Spurauswahl und gesetzte In- und Out-Punkte werden danach wiederhergestellt, auch nach einem Fehler. Ist **Jeden Clip nach dem Schnitt prüfen** eingeschaltet (Standard), werden anschließend alle Clippositionen, Medienzuordnungen und ein vorhandenes Backup geprüft. Bei unerwartetem Zustand gibt es keine Erfolgsmeldung. Ein bereits begonnener Eingriff wird nicht automatisch zurückgerollt. In diesem Fall steht das Backup zum Wiederherstellen bereit, sofern es eingeschaltet war.

Für den Export entsteht keine Kopie der Sequenz. Audioexport und jedes Schnittpaket blockieren Premiere kurz. Ein Abbruch greift zwischen zwei Paketen, die Rust-Analyse ist jederzeit abbrechbar. Laufbelege inklusive WAV-Dateien bleiben im temporären Ordner `open-silences-evidence` erhalten.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| Noise Floor (`thresholdDb`) | Audio strikt unter diesem Pegel gilt als Stille. Größere Werte entfernen eher leise Passagen. |
| Stillen ab (`minPause`) | Kürzester Schnitt, gemessen nach Abzug der Luft. Kürzere Pausen bleiben erhalten. |
| Sprache ab (`minSpeech`) | Sprache zwischen zwei Schnitten, die samt Luft kürzer ist, wird mitgeschnitten. |
| Luft vor Sprache (`leadIn`) | Audio vor dem nächsten Sprachstück, das erhalten bleibt. |
| Luft nach Sprache (`tail`) | Audio nach dem vorigen Sprachstück, das erhalten bleibt. |
| Abstand zwischen Schnitten (`minCutSpacing`) | Liegen Schnitte näher beieinander, bleibt jeweils der längste stehen. 0 schaltet das aus (Standard). |
| Was geschnitten wird (`cutScope`) | **Ganze Auswahl** (Standard): alle Spuren an jeder Pause, auch zwischen Clips. **Nur unter Sprachclips**: nur dort, wo auf einer gewählten Sprachspur ein Clip liegt. |
| Absicherung | Backup und Prüfung nach dem Schnitt sind eingeschaltet, der zweite Export vor dem Schnitt ist aus. Alle drei lassen sich einzeln schalten. |

Jede Schnittkante liegt zwischen den 20-ms-Pegelwerten dort, wo die Sprache ausklingt, und wird nach innen auf ganze Frames gerundet. Ein einzelner Frame ist ein gültiger Schnitt. Die vollständige Erkennung steht in `docs/DETECTION.md`.

**Pegel automatisch schätzen** teilt die Pegel des gewählten Bereichs lokal in zwei Gruppen, Raumton und Sprache, und schlägt die Obergrenze des Raumtons in ganzen dB vor. Das ist eine statistische Schätzung, keine Cloudfunktion. Der Vorschlag lässt sich manuell ändern.

In/Out müssen tatsächlich in Premiere gesetzt sein. Bei ausgewählten Clips werden deren Zeitbereiche vereinigt. Lücken zwischen getrennten Bereichen werden nicht bearbeitet. Ripple verschiebt nachfolgende Clips entsprechend der entfernten Dauer.

## Geprüfter Umfang

macOS arm64, Premiere Pro **26.5.2**. Eigene 12-Sekunden-Farbtafeln mit Stereo-Ton und zwei bekannten Stillen bilden die Hosttests. Bisher wurden 25 und 59,94 fps, alle drei Bereichsarten, bestehende Schnittgrenzen und mehrere Tonspuren im echten Host geprüft. Der Schnitt in Paketen und der Mono-Float-Export wurden an einem 35-Minuten-Rohschnitt mit 59,94 fps im echten Host geprüft. Weitere Bildraten sind dort noch nicht geprüft. Frame-Rundung erfolgt nach innen, damit Schnitte nicht über den gewählten Bereich hinausreichen. Die Abnahme des installierten Panels in Premiere Pro steht noch aus.

Andere Premiere-Versionen und Windows sind nicht freigegeben. Gesperrter Content, fehlende Medien und ungeeignete Timeline-Zustände können den Schnitt stoppen. Ein Übergang stoppt nur die Pause, in der er liegt. Panel, Vorschau und CLI nennen dann den Grund. QE ist eine undokumentierte Adobe-Schnittstelle. Die Nachprüfung schützt den unterstützten Ablauf, sie ist keine Garantie für beliebige komplexe Projekte. Eine einzelne Undo-Gruppe wird nicht zugesagt.

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
