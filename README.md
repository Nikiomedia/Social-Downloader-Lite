# Aurora Vault

Web-App, die Bilder und Reels eines Facebook-Profils in voller Auflösung sammelt. Einzeln per Klick auf das Download-Symbol oder alles zusammen als ZIP. Alle Downloads laufen über das normale Download-Fenster des Browsers, auf dem Server wird nichts abgelegt.

Nur für Inhalte verwenden, die du nutzen darfst (z. B. deine eigene Seite oder Inhalte mit Erlaubnis).

## Hinweis zu Kontosperren

**Automatisierte Scans und Massendownloads können Anfragebegrenzungen, Sicherheitsprüfungen und vorübergehende Kontoeinschränkungen auslösen. Bei Verstößen gegen Plattformregeln sind auch dauerhafte Kontosperren möglich.** Bereits das Scannen und die HD-Prüfung erzeugen Anfragen.

Die eingebauten Pausen und die begrenzte Parallelität reduzieren die Anfragerate, garantieren aber keinen Schutz vor Sperren. Für diese App gibt es keine verlässlich sichere Anzahl von Downloads oder garantierte Wartezeit.

Bei Warnungen oder Einschränkungen die App beenden und die Hinweise der Plattform beachten. Nicht wiederholt neu starten oder mehrere App-Versionen gleichzeitig für dasselbe Konto verwenden. Verbinde kein Konto, dessen Einschränkung du nicht riskieren kannst.

Beachte die jeweiligen Plattformbedingungen. Eine Erlaubnis des Urhebers für die Inhalte ersetzt keine gegebenenfalls nötige Erlaubnis der Plattform für automatisierte Zugriffe. [Meta beschreibt Anfragebegrenzungen und Kontodeaktivierungen als Maßnahmen gegen unerlaubtes Scraping.](https://about.fb.com/news/2021/04/how-we-combat-scraping/)

## Starten

1. Einmalig [Node.js LTS](https://nodejs.org) installieren (Version 20 oder neuer).
2. `start.bat` doppelklicken.
   - Beim ersten Start werden die Abhängigkeiten installiert (dauert ca. 20 Sekunden).
   - Danach öffnet sich die App automatisch im Browser: `http://localhost:4870`
3. Das schwarze Server-Fenster offen lassen. Schließen beendet die App.

Ohne Login ausprobieren: **Demo ansehen** klicken. Die Demo nutzt Beispielbilder aus `public/demo` und funktioniert komplett offline.

## Mit Facebook verbinden

1. Oben rechts auf **Mit Facebook verbinden** klicken.
2. Es öffnet sich ein eigenes Edge-Fenster. Dort normal einloggen (inkl. Zwei-Faktor-Code).
3. Sobald der Login durch ist, schließt sich das Fenster von selbst. Oben rechts steht dann dein Name.

Die Sitzung liegt nur lokal im Ordner `session/`. Dein normaler Browser bleibt unberührt.
Abmelden über den Namen oben rechts → **Abmelden und Sitzung löschen**.

## Benutzen

- Profil-Link einfügen, z. B. `https://www.facebook.com/profile.php?id=61594033984017` oder `facebook.com/name`, dann **Scannen**.
- **Gruppen** gehen auch: Gruppen-Link einfügen, z. B. `facebook.com/groups/462936445355492`. Gesammelt werden die Fotos und Videos aus dem Medien-Tab der Gruppe (die Videos stehen im Tab **Reels**). Private Gruppen nur, wenn dein verbundenes Konto Mitglied ist.
- Tabs **Alle / Bilder / Reels** filtern die Ansicht. **Nur HD** (Taste `H`) zeigt nur Medien mit HD-Link. Dafür prüft die App im Hintergrund alle Links, der Fortschritt steht in der leeren Ansicht. Reels, die Facebook nur in SD anbietet, tragen ein gelbes **SD**-Label.
- **Download-Symbol** auf einer Kachel lädt die Datei in Originalgröße.
- **Reels mit der Maus überfahren** spielt sie stumm direkt in der Kachel ab (mit Fortschrittslinie). Ein Klick öffnet das Reel dann in der Lightbox an derselben Stelle, mit Ton.
- Klick auf das **Bild** öffnet die Lightbox (Card-Spin). Blättern mit ← →, Wischen auf dem Handy, Schließen mit Esc. Am Anfang und am Ende der Liste geht es nicht weiter (kein Sprung zurück zum Anfang), die Karte federt kurz und zeigt „Anfang“ bzw. „Ende der Liste“. Die Knöpfe neben der Nummer oben links springen zum ersten und letzten Medium, per Tastatur `Pos1` / `Ende`. Blättern bleibt im aktuellen Tab (Alle, Bilder oder Reels).
- **Ton aus** bei einem Reel (Lautsprecher-Symbol oder Taste `M`) bleibt gemerkt, auch für die nächsten Reels und nach dem Neuladen, bis du den Ton wieder einschaltest.
- **Position im Reel:** auf den Fortschrittsbalken klicken oder gedrückt halten und ziehen. Beim Überfahren zeigt eine Blase die Zeit an der Mausposition.
- **Lautstärke** mit dem Regler neben dem Lautsprecher, mit dem Mausrad über dem Lautsprecher oder mit den Tasten ↑ ↓ (5-%-Schritte). Die Lautstärke wird ebenfalls gemerkt. Regler ganz nach links = Ton aus; beim Wiedereinschalten kommt die vorherige Lautstärke zurück. Auf iPhone/iPad fehlt der Regler, weil iOS die Lautstärke nur über die Tasten am Gerät erlaubt.
- **Alles als ZIP** packt den aktuellen Tab. Mit **Auswählen** (Taste `S`) markierst du einzelne Kacheln, Shift-Klick markiert einen Bereich. Das ZIP wird gepackt, während es herunterlädt (keine Zwischendatei auf dem Server) und enthält eine `manifest.json` mit allen Metadaten.
- Bereits geladene Medien bekommen ein grünes **Geladen**-Label. Das merkt sich der Browser pro Profil.
- **Favoriten:** Nach einem Scan auf **Merken** klicken. Favoriten stehen oben rechts unter **Favoriten** und auf der Startseite, ein Klick startet den Scan. Im Favoriten-Menü gibt es **Exportieren** und **Importieren** (JSON-Datei).
- Der runde Pfeil unten rechts bringt dich wieder nach oben.
- **Während des Scans** zeigt der Profilbereich die Schritte Bilder → Reels → Fertig, einen Lichtstrahl und einen Fortschrittsbalken. Am Ende des Rasters warten schimmernde Platzhalter auf neue Kacheln.
- **Spiel spielen, während du wartest:** Beim Scan, bei der HD-Prüfung und beim ZIP-Packen erscheint ein Button für **Aurora Snake**. Die Schlange frisst die Bilder, die der Scan gerade findet. Steuerung mit Pfeiltasten/WASD oder Wischen, Leertaste = Pause, Esc = schließen. Ist der Scan fertig, hält das Spiel an und zeigt groß **Scan abgeschlossen** (mit Feuerwerk und Anzahl der Funde): **Weiterspielen** (Leertaste) oder **Zu den Ergebnissen** (Enter). Liegt der Tab im Hintergrund, steht „✓ Scan fertig“ im Tab-Titel. Mit der Taste `G` geht das Spiel jederzeit auf.

Tastatur: `/` Suche · `1` `2` `3` Tabs · `S` Auswahl · `A` alle markieren (im Auswahlmodus) · `H` nur HD · `G` Spiel · `Esc` beenden.

Kleine Extras zum Entdecken: Farbwelt-Schalter unten rechts, Klick in den leeren Himmel, fünfmal schnell aufs Logo …

## Ordner

| Ordner / Datei | Inhalt |
| --- | --- |
| `server.js` | Lokaler Server: Seiten, Downloads, ZIP, Medien-Proxy |
| `lib/fb.js` | Facebook-Zugriff über Edge/Chrome (Playwright) |
| `lib/demo.js` | Demo-Profil |
| `public/` | Oberfläche (HTML, CSS, JS, Schriften, Demo-Medien) |
| `public/js/card-spin.js` + `public/css/card-spin.css` | Card-Spin-Lightbox (unverändert aus dem Skill) |
| `data/favorites.json` | Deine Favoriten (inkl. Profilbild) |
| `session/` | Facebook-Login (privat, nicht weitergeben) |

## Sichern und weitergeben

- **Backup der Favoriten:** im Favoriten-Menü **Exportieren**, oder den Ordner `data/` kopieren.
- **App weitergeben:** `pack.bat` erstellt `aurora-vault.zip` **ohne** Login und ohne Favoriten.
- Ein alter Ordner `downloads/` aus der ersten Version wird nicht mehr gebraucht und kann gelöscht werden.
- `session/` enthält deine Facebook-Cookies. Diesen Ordner nie weitergeben.

## Auf einem Server betreiben

- Standardmäßig ist die App nur am eigenen Rechner erreichbar (`127.0.0.1`).
- Für den Zugriff aus dem Netzwerk: `set HOST=0.0.0.0` und **unbedingt** ein Passwort setzen: `set AV_PASSWORD=deinPasswort`. Der Browser fragt dann nach Benutzer und Passwort (Benutzername egal).
- Ohne Passwort könnte jeder im Netzwerk deinen Facebook-Login über die App nutzen.
- Der einmalige Facebook-Login braucht ein sichtbares Browserfenster. Auf einem Server ohne Bildschirm: am PC verbinden und den Ordner `session/` auf den Server kopieren.
- `set NO_OPEN=1` verhindert, dass beim Start ein Browser aufgeht.

## Wenn etwas hakt

- **„Kein Microsoft Edge oder Google Chrome gefunden“**: Edge ist bei Windows 11 dabei. Falls entfernt, Chrome installieren.
- **„Bitte zuerst mit Facebook verbinden“** mitten im Scan: Die Sitzung ist abgelaufen. Neu verbinden.
- **„Facebook bremst gerade“**: Die Plattform begrenzt Anfragen. Beim Nachladen von Medienlinks wartet die App bei einem erkannten Limit eine Minute und versucht es erneut. Das ist keine Entwarnung der Plattform. Beende die App bei dieser Meldung und beachte die Hinweise der Plattform.
- **Profil nicht erreichbar**: privat, gelöscht oder für dein Konto nicht sichtbar.
- **Anderer Port**: `set PORT=5000` vor `node server.js`, oder der Server nimmt automatisch den nächsten freien Port.
- **Browser erzwingen**: `set AV_BROWSER=chrome` (oder `msedge`).

Facebook ändert seine Seiten regelmäßig. Wenn Bilder oder Reels plötzlich nicht mehr gefunden werden, liegt die Erkennung in `lib/fb.js` (`extractTilesInPage`, `resolvePhotoInPage`, `resolveReelInPage`).

## Technik in Kürze

- Node.js-Server ohne Framework, nur zwei Pakete: `playwright-core` (steuert Edge/Chrome, lädt keinen eigenen Browser herunter) und `archiver` (ZIP).
- Der Scan scrollt den Fotos- und den Reels-Tab des Profils in einem unsichtbaren Browser und sammelt die Kacheln.
- Volle Auflösung: Für jedes Bild wird die Foto-Seite gelesen, für jedes Reel die HD-MP4 (mit Ton) aus der Video-Seite. Das passiert automatisch für sichtbare Kacheln und beim Download.
- Die Oberfläche ist reines HTML/CSS/JavaScript (ES-Module), der Hintergrund ein WebGL-Shader mit automatischer Qualitätsanpassung für schwächere Grafik.
