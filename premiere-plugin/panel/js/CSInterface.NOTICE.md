# CSInterface.js: Herkunft und Lizenz

`panel/js/CSInterface.js` ist **nicht** unser Code. Es ist die von Adobe
veröffentlichte CEP Brücke.

| Punkt | Wert |
|---|---|
| Quelle | `https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_11.x/CSInterface.js` |
| Projekt | Adobe CEP Resources, `CEP_11.x` |
| Abruf | 8. Oktober 2026, per `curl` direkt aus dem Repository |
| Dateigröße | 42759 Bytes |
| sha256 | `d940cbc991553b4885d1b3b04d99c17f448041a738a12cc0b24ce688ace2d263` |
| Kopfzeile der Datei | `Copyright 2020 Adobe Systems Incorporated. All Rights Reserved.` |
| Lizenz | Adobe General SDK License Agreement, englische Fassung: `License/GenSDK_IHC-en_US-20120323_1224.pdf` |
| Lizenzdatei im Workspace | `premiere-plugin/licenses/GenSDK_IHC-en_US-20120323_1224.pdf` |
| Lizenzdatei Abruf | 8. Oktober 2026, 95659 Bytes, 6 Seiten, sha256 `32e814081efd3495074202f7f8717aad14743b2d17b55298e92d7c4ece495383` |
| Lizenz-URL | https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/License/GenSDK_IHC-en_US-20120323_1224.pdf |

Es gilt **keine** allgemeine MIT Lizenz für die Adobe SDK Bestandteile. Es wird
hier keine Lizenz behauptet, die nicht im Repository liegt.

## Auflagen für ein öffentliches Paket

1. Beide Dateien wurden unabhängig direkt von den offiziellen Adobe URLs geladen
und sind bytegleich mit den Kopien im Workspace. Die Hashes werden durch
`premiere-plugin/test/package.test.mjs` gegen die ausgelieferten Dateien geprüft.

Die Datei muss aus dem offiziellen Adobe Repository stammen, nicht aus dem
   Ordner einer installierten Fremderweiterung. Der Kopfzeilenvermerk
   `Copyright 2020 Adobe Systems Incorporated` bleibt unverändert.
2. Die Lizenzdatei `GenSDK_IHC-en_US-20120323_1224.pdf` muss im Paket liegen,
   zusammen mit diesem Hinweis.
3. Der urheberrechtliche Vermerk und dieser Herkunftshinweis bleiben im Paket.
4. Solange Lizenz und Freigabe nicht geprüft sind, bleibt das Paket im
   privaten Entwicklungsrepository und wird nicht öffentlich veröffentlicht.
   Siehe `LICENSE-STATUS.md` und `docs/RELEASE-CHECKLIST.md`.
