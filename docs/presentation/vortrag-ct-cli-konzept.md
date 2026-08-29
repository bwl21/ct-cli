# Vortrag: ct-cli – inhaltliches Konzept

Arbeitsstand für einen technischen Vortrag am 27. August 2026. Das Konzept ist
für etwa **30–35 Minuten plus Fragen** ausgelegt. Es ist bewusst noch kein
ausformulierter Foliensatz.

Primärquelle für die Hauptgeschichte ist die bereits vorhandene reale
Fallstudie im `ct-masterdata`-Repository:

```text
churchtools-processes/docs/fallstudie-ojbp-vom-bestand-zum-blueprint.md
```

Sie dokumentiert sowohl das tatsächlich durchgeführte Extraktionsverfahren als
auch eine sprachlich bereinigte Chronik der entscheidenden Nutzerprompts. Für
den Vortrag werden daraus wenige Wendepunkte ausgewählt; die Journey wird nicht
nachträglich als geradlinige Erfolgsgeschichte geglättet.

## Kurzversion für fünf Minuten

Für einen sehr kurzen Beitrag wird die Journey auf **fünf Folien mit je einer
Aussage** verdichtet. Keine Live-Demo; stattdessen ein vorbereiteter
Plan-Ausschnitt oder Screenshot.

### Folie 1 – ChurchTools Configuration as Code

**Kernaussage:** Was Terraform für Infrastruktur macht, soll ct-cli für die
rechte-tragende ChurchTools-Struktur leisten.

Sprechtext, etwa 40 Sekunden:

> Gruppen, Hierarchien und Berechtigungen werden normalerweise geklickt. Damit
> fehlen Versionierung, Wiederholbarkeit und eine Vorschau auf Änderungen.
> ct-cli beschreibt diese Struktur als gewünschten Zustand in TypeScript und
> gleicht sie über `plan` und `apply` mit ChurchTools ab.

### Folie 2 – Der reale Ausgangspunkt: OJBP jedes Jahr neu

**Kernaussage:** Ein bestehendes, bewährtes Konstrukt sollte nicht erneut
geklickt werden.

```text
OJBP 2025/26
├── 1. Praktikum
├── 2. Praktikum
└── 3. Praktikum
```

Sprechtext, etwa 50 Sekunden:

> Die konkrete Frage war: Wie übernehme ich diese bestehende Struktur und lege
> sie für das nächste Schuljahr wieder an? Beim genaueren Hinsehen bestand sie
> nicht nur aus vier Gruppen, sondern auch aus Hierarchie, 36
> Mitgliedsfelddefinitionen und vier dynamischen Rulesets.

### Folie 3 – Aus dem Bestand wird ein Blueprint

**Kernaussage:** ct-cli erfasst die Realität; der Coding-Agent abstrahiert sie;
`plan` überprüft das Ergebnis.

```text
ChurchTools-Bestand
       ↓ adopt
konkrete Deklarationen
       ↓ Coding-Agent
parametrisierter Blueprint
       ↓ ct plan
überprüfte Änderung
```

Sprechtext, etwa 80 Sekunden:

> Die Adoption lieferte konkrete Gruppen, Felder und Regeln. Der Coding-Agent
> trennte daraus sechs Arten von Information: Invarianten, Parameter,
> berechnete Werte, logische Referenzen, hostgebundene State-Identität und noch
> offene numerische Verträge. Der zentrale Parameter wurde das Schuljahr. Der
> Blueprint-Generator ist heute also nicht Teil von ct-cli; die Kombination aus
> Agent und deterministischem Plan funktioniert aber bereits praktisch.

### Folie 4 – Der Beweis erfolgt auf einem zweiten Host

**Kernaussage:** Portabilität ist erst bewiesen, wenn der erneute Plan
konvergiert.

Groß zeigen:

```ts
defineOjbp(ct, ["26/27"]);
```

Daneben nur die Ergebnisse:

```text
4 Gruppen
36 Mitgliedsfelder
4 Rulesets
danach: 49 No-ops
```

Sprechtext, etwa 80 Sekunden:

> Auf einer leeren Testinstanz wurden neue ChurchTools-IDs erzeugt. Dabei
> tauchten weitere API-Besonderheiten auf und mussten normalisiert werden. Nach
> den Korrekturen ergab der vollständige Plan 49 No-ops – keine Creates, keine
> Updates, keine Deletes und keine Drift. Erst diese Konvergenz bewies, dass
> Blueprint und State zusammen portabel funktionieren.

### Folie 5 – Die eigentliche Erkenntnis

**Kernaussage:** Kreative Abstraktion und deterministische Kontrolle ergänzen
sich.

Großer Schlusssatz:

> Der Agent kann kreativ abstrahieren. `ct plan` muss deterministisch beweisen,
> was diese Abstraktion tatsächlich bewirkt.

Sprechtext, etwa 50 Sekunden:

> Das ist kein fertiges Hochglanzprodukt. Der OJBP-Fall hat Fehler in der
> API-Annahme, fehlende Ressourcen und Ownership-Fragen sichtbar gemacht – und
> dadurch das Modell verbessert. Für das Folgejahr bleibt am Ende tatsächlich
> nur noch ein zusätzlicher Parameter.

Optional als letzte Codezeile einblenden:

```ts
defineOjbp(ct, ["26/27", "27/28"]);
```

### Zwei-Minuten-Notfallfassung

Wenn noch weniger Zeit bleibt, nur drei Bilder beziehungsweise Folien zeigen:

1. OJBP-Baum: „Das wurde bisher jährlich geklickt.“
2. Ablauf `adopt → Coding-Agent → Blueprint → plan/apply`.
3. Ergebnis `4 Gruppen + 36 Felder + 4 Rulesets → 49 No-ops`.

Der gesamte Sprechtext kann dann lauten:

> ct-cli überträgt das Terraform-Prinzip auf ChurchTools-Strukturen. Bei OJBP
> haben wir eine bestehende Jahresstruktur mit Gruppen, Feldern und dynamischen
> Regeln adoptiert. Ein Coding-Agent hat daraus einen parametrierten
> TypeScript-Blueprint gewonnen; ct-cli hat ihn auf einer zweiten Instanz
> geplant und angewendet. Nach den notwendigen Korrekturen konvergierte der
> Plan zu 49 No-ops. Die zentrale Idee ist die Arbeitsteilung: Der Agent
> abstrahiert kreativ, der Plan überprüft deterministisch. Das nächste Jahr ist
> danach nur noch ein weiterer Blueprint-Parameter.

## Kommunikationsziel

Am Ende sollen technisch versierte Zuhörer verstehen, **wie ct-cli das
Terraform-Prinzip auf die Konfiguration eines ChurchTools-Systems überträgt**:
Die rechte-tragende Struktur wird als gewünschter Zustand in Code beschrieben,
vor einer Änderung geplant und anschließend kontrolliert mit der Live-Instanz
abgeglichen.

Der Vortrag soll dabei ausdrücklich **keine Präsentation eines fertig
geschliffenen Produkts** sein. Er zeigt anhand des realen OJBP-Jahreswechsels,
wie sich die Konzepte aus einem konkreten Problem, Fehlversuchen, API-Funden und
iterativen Modellierungsentscheidungen entwickelt haben.

Die Kernthese:

> ct-cli macht die Konfiguration der rechte-tragenden ChurchTools-Struktur zu
> Code: deklarativ, versionierbar, planbar und reproduzierbar – nach dem
> Terraform-Prinzip von `plan` und `apply`.

Kurzform für Titel, Untertitel oder Ankündigung:

> **ChurchTools Configuration as Code**  
> Terraform-Prinzipien für Gruppen, Hierarchien und Berechtigungen

Die notwendige Präzisierung folgt direkt danach: Nicht die gesamte
ChurchTools-Instanz wird verwaltet. ct-cli verwaltet nur das deklarierte oder
bewusst adoptierte, rechte-tragende Gerüst. Personen und Mitgliedschaften
bleiben außerhalb dieser Grenze.

Der praktische Beweis des Vortrags ist ein durchgehender Migrationspfad:

> Bestehendes ChurchTools-System → Konstrukt adoptieren → portablen Blueprint
> gewinnen → auf einem neuen System ausrollen → für das nächste Jahr erneut
> instanziieren.

Der wichtigste Schritt darin ist **nicht** `adopt` oder `apply`, sondern die
Transformation zwischen beiden:

> Adoption liefert eine konkrete Instanz als Code. Blueprint-Gewinnung trennt
> anschließend die wiederverwendbare Struktur von den variablen Parametern.

ct-cli kann diese Trennung nicht vollständig automatisch entscheiden. Ob
„2025/26“, ein Campus, drei Praktika oder eine bestimmte Gruppe ein Parameter,
eine Invariante oder eine externe Abhängigkeit ist, ist fachliches Wissen. Der
Werkzeugbeitrag besteht darin, dafür eine portable Ausgangsbasis zu erzeugen
und das Refactoring anschließend mit einem No-op-Plan überprüfbar zu machen.

**Produktgrenze im aktuellen Stand:** Es gibt keinen Befehl wie
`ct blueprint generate`. `ct adopt` gibt konkrete `ct.group(...)`-Deklarationen
aus. Der Blueprint entsteht heute durch menschliches oder extern
assistiertes TypeScript-Refactoring. Das darf im Vortrag nicht als autonome
Funktion von ct-cli dargestellt werden.

### Der heute bereits praktikable Weg: ct-cli plus Coding-Agent

Der OJBP-Prozess ist dafür ein reales Beispiel. Im separaten
`ct-masterdata`-Projekt hat ein Coding-Agent aus der adoptierten Struktur, den
Ruleset-Snapshots und den fachlichen Anforderungen den Blueprint
`processes/ojbp/blueprint/ojbp.ts` erstellt. Der heutige Blueprint erzeugt pro
Schuljahr:

- eine Übersichtsgruppe mit zwölf Gruppenmitgliedsfeldern;
- drei Praktikumsgruppen mit jeweils acht eigenen Mitgliedsfeldern;
- die Eltern-Kind-Beziehungen;
- ein Ruleset für die Übersicht und je ein Ruleset für die Praktikumsgruppen.

Die spätere Bedienung ist auf einen fachlich verständlichen Aufruf reduziert:

```ts
defineOjbp(ct, ["26/27"]);
```

Für das Folgejahr wird nur die Liste erweitert:

```ts
defineOjbp(ct, ["26/27", "27/28"]);
```

Die korrekte Zuordnung im Vortrag lautet deshalb:

| Verantwortung | Werkzeug |
| --- | --- |
| Live-Struktur lesen und adoptieren | ct-cli |
| konkrete Struktur fachlich verstehen und verallgemeinern | Coding-Agent im Config-Projekt |
| Blueprint als TypeScript erzeugen | Coding-Agent |
| Portabilität, Abhängigkeiten und Änderungen prüfen | `ct plan` |
| bestätigten Zustand herstellen | `ct apply` |

Das ist bereits eine gute Hilfestellung für einen Nicht-Programmierer: Er muss
nicht selbst TypeScript refaktorieren, sondern beschreibt dem Agenten, was sich
jährlich ändert und was gleich bleibt. Der Agent erzeugt den Entwurf; ct-cli
liefert anschließend die deterministische Vertrauensprüfung.

Wichtig: Der Agent sollte nicht nur eine rohe State-Datei erhalten. Beim OJBP-
Verfahren gehören die Live-Adoption einschließlich Mitgliedsfeldern und
Rulesets, die sichtbare Hierarchie sowie die fachlichen Erwartungen zum
Arbeitsmaterial. Der State liefert Identität und Ownership, aber allein nicht
die vollständige Bedeutung des Blueprints.

Die Aufgabenteilung lautet:

| Schritt | ct-cli heute | Mensch beziehungsweise externe Assistenz |
| --- | --- | --- |
| bestehende Objekte lesen | automatisch | Auswahl des fachlichen Konstrukts |
| logische Keys und portable Referenzen erzeugen | soweit technisch auflösbar automatisch | Warnungen und Ausnahmen bewerten |
| konkrete Deklarationen ausgeben | automatisch | Ausgabe in die Config übernehmen |
| Parameter und Invarianten erkennen | – | fachliche Entscheidung |
| Blueprint-Funktion schreiben | – | TypeScript-Refactoring |
| Gleichheit mit dem Ursprung prüfen | `ct plan --env source` | Plan beurteilen |
| auf neuem Host ausrollen | `plan` / `apply` | Plan freigeben |
| nächste Jahresinstanz erzeugen | deklarativ nach zusätzlichem Funktionsaufruf | neue Parameterwerte festlegen |

Gerade diese Grenze kann eine starke technische Aussage sein:

> ct-cli automatisiert die Erfassung und die Verifikation. Die Abstraktion
> bleibt eine fachliche Modellierungsentscheidung.

## Wie Blueprint-Gewinnung für Nicht-Programmierer zugänglich werden könnte

Die passende Produktidee ist kein völlig autonomer Generator, sondern ein
**geführter Blueprint-Assistent**. Er reduziert die fachliche Entscheidung auf
wenige verständliche Fragen und erzeugt daraus einen überprüfbaren Entwurf.

### Vorgeschlagener Ablauf

1. **Konstrukt auswählen**  
   Der Nutzer wählt die Wurzelgruppe und sieht den erkannten Teilbaum. Er kann
   Gruppen ein- oder ausschließen, ohne TypeScript zu bearbeiten.

2. **Eine oder besser zwei bestehende Instanzen vergleichen**  
   Aus nur einem Jahr lässt sich nicht zuverlässig erkennen, was variabel ist.
   Existieren beispielsweise OJBP 2024/25 und OJBP 2025/26, kann der Assistent
   Gemeinsamkeiten und Unterschiede gegenüberstellen:

   ```text
   Gleich:       1 Wurzel, 3 Praktikumsgruppen, Hierarchie, Mitgliedsfelder
   Unterschied:  2024_25 ↔ 2025_26 in Keys
   Unterschied:  2024/25 ↔ 2025/26 in Namen
   Gleich:       Gruppentyp, Felddefinitionen, interne Rollen
   ```

   Zwei Beispiele machen aus einer geratenen Abstraktion eine begründete
   Parameterhypothese.

3. **Fachliche Fragen in Alltagssprache beantworten**  
   Statt Code zu verlangen, fragt der Assistent beispielsweise:

   ```text
   „2025/26“ unterscheidet sich zwischen den Konstrukten.
   Soll dieser Wert ein Parameter „Jahrgang“ werden?  Ja

   Beide Konstrukte enthalten drei Praktikumsgruppen.
   Gehört diese Anzahl fest zum Bauplan?               Ja

   Beide verwenden den Gruppentyp „Veranstaltung“.
   Soll er fest sein oder beim Aufruf gewählt werden?  Fest

   Campus „Mainz“ kommt nur in einem Konstrukt vor.
   Parameter, Voraussetzung oder nicht übernehmen?     Parameter
   ```

4. **Blueprint-Entwurf generieren**  
   Der Assistent erzeugt eine normale TypeScript-Datei, aber der Nutzer muss
   sie zunächst nicht verstehen. Für weitere Instanzen bleibt nur ein kleiner,
   verständlicher Aufruf:

   ```ts
   ojbp(ct, {
     key: "2026_27",
     label: "2026/27",
     campus: "mainz",
   });
   ```

5. **Automatisch gegen die Vorlagen validieren**  
   Der Assistent wertet den generierten Blueprint mit den alten Parametern aus
   und vergleicht ihn mit jeder adoptierten Ausgangsinstanz. Akzeptiert wird der
   Entwurf nur, wenn der Source-Plan für beide Beispiele ein No-op ist oder jede
   verbleibende Abweichung ausdrücklich erklärt wurde.

6. **Neue Instanz nur als Plan zeigen**  
   Der Assistent fragt nach den Werten für das nächste Jahr, erzeugt den
   zusätzlichen Aufruf und zeigt den resultierenden Plan. Schreiben bleibt der
   normale, getrennt bestätigte `apply`-Schritt.

### Was sich zuverlässig automatisieren lässt

- gemeinsame Baumform und Gruppentypen erkennen;
- wiederkehrende Textteile und Datums-/Jahresmuster vorschlagen;
- aus Keys ein kollisionsfreies Namensschema ableiten;
- identische Felddefinitionen und Auto-Gruppen-Regeln extrahieren;
- interne Referenzen auf abgeleitete logische Keys umstellen;
- unportable numerische IDs und ungeklärte Referenzen markieren;
- den Blueprint-Entwurf gegen alle Ausgangsinstanzen prüfen.

### Was eine fachliche Entscheidung bleiben muss

- ob zwei ähnlich aussehende Gruppen tatsächlich dieselbe Rolle haben;
- ob eine Abweichung Parameter oder historischer Sonderfall ist;
- ob ein gemeinsam genutztes Objekt zum Blueprint gehört oder extern bleibt;
- ob Berechtigungen Bestandteil des Konstrukts sind;
- welche Namen Nutzer bei der nächsten Instanz sehen sollen.

### Sinnvolle Ausbaustufen

**Kurzfristig – geführtes Rezept:** Ein Wizard und eine dokumentierte
Checkliste erzeugen aus einer Adoption eine vorbereitete Blueprint-Datei. Die
entscheidenden Stellen sind als Fragen beziehungsweise TODOs markiert.

**Mittelfristig – struktureller Vergleich:** Zwei adoptierte Konstrukte werden
normalisiert und anhand von Hierarchie, Typ, relativer Rolle und Felddefinitionen
verglichen. Daraus entstehen Parametervorschläge mit Konfidenz und Begründung.

**Optional – KI-Assistenz:** Ein Coding-Agent kann Namen, Parameter und
Hilfsfunktionen vorschlagen. Er liefert nur einen Entwurf; die deterministische
No-op-Prüfung durch ct-cli bleibt die Vertrauensgrenze.

Die passende Produktbotschaft lautet daher nicht „Blueprints auf Knopfdruck“,
sondern:

> Der Nutzer liefert das fachliche Urteil. Der Assistent übernimmt Code,
> Wiederholungen und Verifikation.

## Empfohlene Hauptdramaturgie: die OJBP-Journey

Die Präsentation sollte nun primär der echten damaligen Konversation folgen.
Die späteren technischen Kapitel dieses Dokuments sind Material für Erklärungen
und Reservefolien, nicht mehr die Hauptgliederung.

### 1. Eine scheinbar einfache Frage

Ausgangspunkt der Journey:

> „Ich habe ein Konstrukt aus einer Gruppe mit drei Untergruppen. Wie kann ich
> das adoptieren und für das nächste Jahr wieder anlegen?“

Visualisiert wird nur die reale Form:

```text
OJBP 2025/26
├── OJBP 1. Praktikum 25/26
├── OJBP 2. Praktikum 25/26
└── OJBP 3. Praktikum 25/26
```

Das ist der ideale Einstieg, weil er ohne Tool-Jargon verständlich ist. Die
gewünschte Wirkung ist ebenfalls klar: nicht alles erneut in ChurchTools
klicken und eintippen.

### 2. Die erste Antwort führt direkt zu Terraform

Die konkrete Instanz soll nicht kopiert, sondern als wiederverwendbare
Definition beschrieben werden:

```ts
defineOjbp(ct, ["25/26"]);
```

Später:

```ts
defineOjbp(ct, ["25/26", "26/27"]);
```

Hier wird das Terraform-Modell eingeführt:

- TypeScript beschreibt den gewünschten Zustand.
- Logische Keys identifizieren fachliche Objekte.
- Der State bindet Keys an ChurchTools-IDs.
- `plan` zeigt den Unterschied.
- `apply` stellt den Zustand her.

Die wichtige Erkenntnis aus der damaligen Diskussion:

> Die fachliche Struktur lebt im Blueprint. Die Verbindung zu den realen
> Objekten lebt im State.

### 3. Aber woher kommt der Blueprint?

Die nächste Nutzerfrage war entscheidend:

> „Ich möchte die vorhandenen Gruppen als Vorlage nehmen und nicht alles von
> Hand neu eintippen.“

Damit entsteht der zunächst gedachte Prozess:

```text
bestehende Struktur
      ↓
adoptieren
      ↓
konkrete TypeScript-Deklarationen
      ↓
zum Blueprint verallgemeinern
      ↓
für ein neues Jahr aufrufen
```

An diesem Punkt wird offen gesagt: ct-cli besitzt keinen eingebauten
Blueprint-Generator. Der Weg wird später durch einen Coding-Agenten ergänzt.

### 4. Schon die Adoption scheitert an der Realität

Der erste Live-Versuch lieferte trotz sichtbarer Untergruppen:

```console
$ ct adopt group --children-of 2424
No groups matched — nothing to adopt.
```

Die UI zeigte den Baum, die CLI sah keinen. Ursache war nicht das Fachmodell,
sondern die konkrete Form der ChurchTools-API-Antwort: Der reale Children-
Endpunkt und der damalige Test-Double hatten unterschiedliche Shapes.

Das ist ein wichtiger konzeptioneller Moment:

> Infrastructure as Code ist nur so zuverlässig wie das tatsächliche
> Verhalten des Providers – nicht wie seine angenommene Dokumentation.

Aus dem OJBP-Fall entstand eine Absicherung für paginierte beziehungsweise
eingehüllte Children-Antworten, Fehlerweitergabe und zyklensichere Rekursion.

### 5. Adoption funktioniert – aber das Ergebnis ist unvollständig

Die Wurzel konnte anschließend adoptiert werden:

```ts
group({
  key: "ojbp_2025_26",
  name: "OJBP OJAHR Praktikum Übersicht 25/26",
  groupType: "ojbp_ojahr_praktikum",
  groupStatusId: 1,
});
```

Das sah zunächst plausibel aus. Dann kam die entscheidende Nachfrage:

> „Was ist mit den in den Gruppen definierten Gruppenmitgliedsfeldern?“

Die Gruppe war adoptiert, aber nicht das vollständige fachliche Konstrukt.

### 6. Ein UI-Objekt ist kein API-Objekt

Die Analyse zeigte, dass das, was in ChurchTools wie „eine Gruppe“ aussieht,
aus mehreren technischen Teilen besteht:

- Gruppenstammdaten;
- Hierarchiebeziehungen;
- gruppeneigene Mitgliedsfelddefinitionen;
- dynamisches Ruleset und Status;
- separat modellierte Berechtigungen;
- Mitglieder, die bewusst niemals Teil des Werkzeugs werden.

Damit verschob sich die Frage von „Wie kopiert man eine Gruppe?“ zu:

> Welche Teile gehören gemeinsam zum Lebenszyklus des fachlichen Konstrukts?

### 7. OJBP verändert das Ressourcenmodell von ct-cli

Die OJBP-Rulesets schrieben in die Felder `praktikum-1`, `praktikum-2` und
`praktikum-3`. Ein neues Jahr mit Gruppe und Ruleset, aber ohne diese
Felddefinitionen wäre formal erfolgreich und fachlich kaputt gewesen.

Aus der Konversation entstand deshalb das Modell der **gruppengebundenen
Unterressource**:

```text
ojbp_2026_27_praktikum_1::wahl
```

Die Feld-ID ist ChurchTools-spezifisch und wird pro neuer Gruppe neu vergeben.
Die portable Identität besteht aus Gruppen-Key und lokalem Feld-Key. Daraus
entstand Issue #135 und schließlich:

```bash
ct adopt group <id> --with-member-fields
```

Konzeptionelle Aussage:

> Der reale Anwendungsfall hat nicht nur eine fehlende Option gefunden, sondern
> die richtige Lifecycle-Semantik des Ressourcenmodells sichtbar gemacht.

### 8. Jetzt gewinnt der Coding-Agent den Blueprint

Nach der Erweiterung standen als Arbeitsmaterial zur Verfügung:

- adoptierte Gruppen und stabile logische Keys;
- Mitgliedsfelddefinitionen ohne hostgebundene Feld-IDs;
- portabilisierte Ruleset-Snapshots;
- die sichtbare Hierarchie;
- fachliche Angaben dazu, was jährlich gleich bleibt und was sich ändert.

Im `ct-masterdata`-Projekt erzeugte der Coding-Agent daraus den tatsächlichen
Blueprint `processes/ojbp/blueprint/ojbp.ts`.

Wichtig für die Erzählung:

- ct-cli hat den Blueprint nicht autonom erzeugt;
- der Nutzer musste aber auch nicht selbst 380 Zeilen TypeScript schreiben;
- der Agent übernahm das Refactoring und die Codeerzeugung;
- ct-cli blieb die deterministische Verifikationsschicht.

### 9. Der Blueprint zeigt, was „Konstrukt“ wirklich bedeutet

Das Ergebnis ist wesentlich mehr als vier kopierte Gruppen. Pro Schuljahr
beschreibt es:

- eine Übersichtsgruppe;
- zwölf Felder an der Übersicht;
- drei Praktikumsgruppen;
- acht eigene Felder pro Praktikumsgruppe;
- Eltern-Kind-Beziehungen;
- ein aktives Übersichts-Ruleset;
- drei bewusst manuelle Praktikums-Rulesets.

In Summe entstehen pro Jahr vier Gruppen und 36 gruppeneigene
Mitgliedsfelddefinitionen. Die Komplexität liegt im Blueprint; der fachliche
Aufruf bleibt klein:

```ts
defineOjbp(ct, ["26/27"]);
```

### 10. Ein neues System deckt die nächsten Abhängigkeiten auf

Auf einer leeren Testinstanz konnte der Blueprint nicht sofort laufen. Zuerst
mussten seine Voraussetzungen existieren:

1. Gruppentypen und Sicherheitsstufen;
2. die OJBP-Teilnehmerrolle;
3. erst danach Voraussetzungen und Jahresstruktur.

Auch das ist Teil der Journey, kein Makel der Demo:

> Portabilität bedeutet nicht Voraussetzungslosigkeit. Sie bedeutet, dass
> Voraussetzungen explizit, planbar und in Abhängigkeitsreihenfolge herstellbar
> werden.

Der erste Apply auf dem zweiten Host deckte außerdem eine weitere falsche
Portabilitätsannahme auf: Auswahlwerte der Mitgliedsfelder mussten als
Namensobjekte geschrieben werden; beim späteren Lesen ergänzte ChurchTools
eigene Options-IDs. ct-cli musste diese Live-IDs normalisieren, damit portable
Namen und Live-Darstellung nicht dauerhaft auseinanderliefen.

Das ist ein zweites Provider-Learning nach dem Children-Endpunkt:

> Portabilität ist erst bewiesen, wenn Create, Read und erneuter Plan auf einem
> anderen Host konvergieren.

### 11. `plan` wird zum gemeinsamen Wahrheitsmoment

Der Plan gegen die Testinstanz sollte zeigen:

- genau vier neue Gruppen;
- genau 36 neue Mitgliedsfelder;
- die erwarteten Eltern;
- keine Änderungen an älteren Jahrgängen.

Nach `apply` muss der nächste Plan ein No-op sein. Damit prüft ct-cli sowohl die
Arbeit des Coding-Agenten als auch die Annahmen über ChurchTools.

Im realen OJBP-Test endete diese Gegenprobe mit **49 No-ops**, ohne Create,
Update, Delete oder Drift. Diese Zahl eignet sich als bewusst nüchterner
Schlusspunkt der technischen Validierung.

Diese Rollenverteilung ist eine der stärksten Aussagen des Vortrags:

> Der Agent kann kreativ abstrahieren. Der Plan muss deterministisch beweisen,
> was diese Abstraktion tatsächlich bewirkt.

### 12. Das Folgejahr ist am Ende tatsächlich nur noch ein Parameter

Nachdem die schwierige Arbeit einmal geleistet wurde:

```ts
defineOjbp(ct, ["26/27", "27/28"]);
```

Der nächste Plan darf nur die neue Instanz hinzufügen. Genau hier löst die
Journey das Versprechen der ersten Folie ein: Bestehendes Wissen wurde nicht
erneut geklickt, sondern in eine wiederverwendbare, überprüfbare Beschreibung
überführt.

### 13. Die offenen Fragen sind Teil des Ergebnisses

Die Konversation endete nicht mit „Produkt fertig“, sondern öffnete weitere
konzeptionelle Fragen:

- Wie werden abgeschlossene Jahresinstanzen archiviert oder aus der aktiven
  Verwaltung genommen?
- Wie entwickelt sich ein Blueprint weiter, ohne historische Jahrgänge
  ungewollt zu verändern?
- Wie werden gemeinsam genutzte Voraussetzungen konsumiert, ohne ihre
  Lifecycle-Ownership zu übernehmen?
- Wie viel der Blueprint-Gewinnung sollte künftig als geführter Assistent in
  ct-cli selbst landen?

Der Schlusspunkt ist daher keine Produktwerbung, sondern eine Engineering-
Erkenntnis:

> Ein reales Problem schärft das Modell. Das Modell schärft das Werkzeug. Und
> `plan` hält beide gegenüber der Realität ehrlich.

## Gesprächsartefakte für die spätere Präsentation

Aus der damaligen Konversation eignen sich wenige, große Ausschnitte besser als
viele kleine Chat-Screenshots:

1. die ursprüngliche Frage nach Gruppe plus drei Untergruppen;
2. „vorhandene Gruppen als Vorlage, nicht neu eintippen“;
3. die echte Fehlermeldung `No groups matched`;
4. die zunächst plausible, aber unvollständige Adoptionsausgabe;
5. die Nachfrage nach den Gruppenmitgliedsfeldern;
6. die daraus entwickelte Identität `<group-key>::<field-key>`;
7. der fertige Einzeiler `defineOjbp(ct, ["26/27"]);`;
8. der Plan mit vier Gruppen und 36 Feldern.
9. das Ergebnis des zweiten Hosts: `49 No-ops`.

Damit entsteht visuell eine Entwicklung von **Frage → Irritation → Modell →
Implementierung → Beweis**, nicht der Eindruck einer Hochglanz-Produktdemo.

## Dramaturgie

Der Vortrag folgt nicht einer Feature-Liste, sondern einer zunehmenden
Auflösung des Problems:

1. In einem bestehenden ChurchTools-System steckt bereits wertvolle Struktur
2. Diese Struktur wird bewusst adoptiert und als konkrete Instanz in Code überführt
3. Struktur, Parameter und externe Abhängigkeiten werden getrennt
4. Ein No-op-Plan beweist, dass der gewonnene Blueprint dieselbe Struktur beschreibt
5. `plan` und `apply` bringen ihn kontrolliert in ein neues System
6. Ein zweiter Funktionsaufruf erzeugt die Struktur für das nächste Jahr
7. State, Ownership und Guardrails erklären, warum das sicher funktioniert

## Vorgeschlagene Folienfolge

### 1. ChurchTools-Konfiguration ist Infrastruktur

**Aussage:** Gruppen, Hierarchien und Rechte sind kein beiläufiges
Konfigurationsdetail; sie bestimmen Zugriffe und organisatorische Abläufe.

Einstieg mit vier Fragen, die eine geklickte Konfiguration schlecht
beantwortet:

- Wer hat diese Berechtigung geändert – und warum?
- Was unterscheidet Test und Produktion?
- Wie reproduzieren wir dieselbe Struktur für einen weiteren Campus?
- Was würde eine geplante Änderung tatsächlich verändern?

Auflösung am Ende der Folie:

> Was wäre, wenn wir ChurchTools-Struktur so behandeln könnten wie Terraform
> Infrastruktur behandelt?

### 2. Das Terraform-Prinzip, auf ChurchTools übertragen

**Aussage:** ct-cli ist „Configuration as Code“ für die rechte-tragende
ChurchTools-Struktur.

Die Analogie knapp und technisch sauber setzen:

| Terraform-Welt | ct-cli-Welt |
| --- | --- |
| HCL / gewünschte Infrastruktur | TypeScript-DSL / gewünschte CT-Struktur |
| Provider und Cloud-API | ChurchTools-API und ct-Ressourcen-Registry |
| Terraform State | hostgebundene ct-State-Datei |
| `terraform plan` | `ct plan` |
| `terraform apply` | `ct apply` |
| Module | TypeScript-Blueprints |
| Workspaces / getrennte States | Environments mit eigenem Host und State |

Dann die bewussten Unterschiede nennen:

- ct-cli verwaltet nur einen klar begrenzten Teil von ChurchTools.
- Bestehende Objekte werden bewusst adoptiert; nichts wird automatisch
  „entdeckt und übernommen“.
- `apply` löscht nie; Löschen ist ein eigener Vorgang.
- Personen und Mitgliedschaften bleiben grundsätzlich außerhalb des Modells.

Diese Folie ist die begriffliche Klammer für den restlichen Vortrag.

### 3. Das Ziel ist nicht Automatisierung um jeden Preis

**Aussage:** ct-cli verwaltet ein bewusst begrenztes, rechte-tragendes Gerüst.

In Scope:

- Campuses, Gruppen und Hierarchien
- Gruppentypen, Rollen und ausgewählte Stammdaten
- Berechtigungen
- Auto-Gruppen und Gruppen-Mitgliedsfelddefinitionen
- wiederholbare Strukturen als TypeScript-Blueprints

Außerhalb der Grenze:

- Personen
- Mitgliedschaften, Teilnahmen und Anwesenheit
- individuelle Datensatzwerte
- nicht unterstützte ChurchTools-Module

Der Satz „People are never managed“ ist eine Architekturgrenze, kein noch
offenes Feature.

### 4. Drei Wahrheiten müssen gleichzeitig betrachtet werden

**Aussage:** Ein sicherer Plan ist kein einfacher Vergleich von Datei und API.

Das mentale Modell:

- **Desired:** `ct.config.ts` beschreibt den gewünschten Zustand.
- **Owned / last known:** Die State-Datei ordnet logische Keys konkreten
  ChurchTools-IDs zu und hält den zuletzt bekannten verwalteten Stand fest.
- **Actual:** ChurchTools liefert den aktuell vorgefundenen Zustand.

Daraus kann ct-cli unterscheiden:

- Änderung aus der Config
- manuelle Drift in ChurchTools
- gleichzeitige Änderung in Config und ChurchTools
- nicht verwaltete Objekte, die vollständig unsichtbar bleiben

Hier bietet sich die einzige zentrale Grafik des Vortrags an: drei Quellen
laufen in `ct plan` zusammen.

### 5. Portabilität beginnt mit logischer Identität

**Aussage:** ChurchTools-IDs sind Hostdetails, keine tragfähigen
Konfigurationsschlüssel.

Ein kleines Codebeispiel genügt:

```ts
ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

ct.group({
  key: "mainz_kids",
  name: "Mainz · Kids",
  groupType: "ministry_team",
  campus: "mainz",
  parents: ["mainz_kids_lead"],
});
```

Erklären:

- `key` ist die stabile Identität im ct-Projekt.
- Referenzen verwenden Keys oder Namen statt numerischer IDs.
- Die Auflösung auf Live-IDs geschieht pro Host beim Planen.
- Noch nicht existierende, aber im selben Lauf erzeugte Ziele werden als
  Abhängigkeiten erkannt und später mit der neu erzeugten ID verbunden.

### 6. Adoption ist eine Ownership-Entscheidung

**Aussage:** `ct adopt` bedeutet nicht „importieren“, sondern „dieses Projekt
übernimmt Lebenszyklus-Verantwortung“.

Die fünf Kategorien des Adoption-Vertrags auf eine verständliche Form
verdichten:

1. Das ausgewählte Wurzelobjekt wird übernommen.
2. Strukturell gehörende Kindobjekte werden mit übernommen.
3. Beziehungen werden nur erfasst, wenn beide Enden verwaltet sind.
4. Gemeinsam genutzte Referenzen werden nicht transitiv übernommen.
5. Personenbezogene Daten werden niemals gelesen oder verwaltet.

Wichtiges Beispiel: Eine Gruppe kann auf einen Campus oder eine andere Gruppe
verweisen. Diese Referenz macht das Ziel nicht automatisch zum Eigentum dieses
ct-Projekts.

Übergang zur Demo:

> Wir starten also nicht auf der grünen Wiese. Wir nehmen ein vorhandenes,
> funktionierendes Gruppenkonstrukt und machen seine Struktur explizit.

### 7. Adoption ist der Rohstoff, noch nicht der Blueprint

**Aussage:** Die Adoptionsausgabe ist eine konkrete, hostbereinigte
Beschreibung des vorhandenen Jahres – kein automatisch erkannter Bauplan.

Beispiel der Ausgangslage nach der Adoption, stark gekürzt:

```ts
ct.group({
  key: "ojbp_2025_26",
  name: "OJBP 2025/26",
  groupType: "event_structure",
});

ct.group({
  key: "ojbp_1_praktikum_2025_26",
  name: "OJBP 1. Praktikum 2025/26",
  groupType: "event_structure",
  memberFields: [/* adoptierte Felddefinitionen */],
});
```

Diese Ausgabe enthält zwei unterschiedliche Dinge vermischt:

- die **wiederverwendbare Form** des Konstrukts;
- die **konkreten Werte** dieser einen Instanz.

Die zentrale Frage des Vortrags lautet daher:

> Welche Teile gehören zum Bauplan – und welche Teile beschreiben nur das Jahr
> 2025/26?

### 8. Blueprint-Gewinnung ist ein kontrolliertes Refactoring

**Aussage:** Aus der adoptierten Instanz wird in fünf nachvollziehbaren
Entscheidungen ein Blueprint.

Dieser Schritt wird **nicht von ct-cli selbst ausgeführt**. In der Demo wird er
als nachvollziehbares TypeScript-Refactoring gezeigt – idealerweise mit drei
vorbereiteten Zwischenständen. Falls ein Coding-Agent dabei eingesetzt wird,
ist er ein separates Hilfsmittel und muss auch so benannt werden.

#### 1. Die fachliche Grenze des Konstrukts festlegen

Welche Objekte gehören gemeinsam in den Lebenszyklus?

- Jahreswurzel und Praktikumsgruppen: Teil des Blueprints
- gruppeneigene Mitgliedsfelddefinitionen: Teil des Blueprints
- gemeinsam genutzter Campus oder Gruppentyp: Referenz oder Voraussetzung
- Personen und Mitgliedschaften: niemals Teil des Blueprints
- Berechtigungen: nur aufnehmen, wenn sie fachlich zum Konstrukt gehören und
  separat adoptiert beziehungsweise deklariert wurden

#### 2. Veränderliche Literale markieren

Im konkreten Code alle Werte markieren, die bei einer neuen Instanz wechseln:

```text
ojbp_2025_26                    → technischer Perioden-Key
OJBP 2025/26                   → sichtbare Bezeichnung
1. Praktikum / 2. Praktikum    → Rollen innerhalb des Konstrukts
Campus Mainz                   → möglicherweise Parameter oder externe Referenz
```

Nicht jedes Literal muss ein Parameter werden. Nur fachlich relevante
Variabilität gehört an die Funktionsgrenze.

#### 3. Ein stabiles Key-Schema bilden

Keys müssen aus Instanz und Rolle zusammengesetzt werden:

```ts
const root = `ojbp_${period.key}`;
const practice = (n) => `${root}_praktikum_${n}`;
```

Damit bleiben zwei Jahresinstanzen im selben Projekt kollisionsfrei, während
Referenzen innerhalb einer Instanz deterministisch entstehen.

#### 4. Die unveränderliche Form extrahieren

Aus wiederholten Deklarationen wird normale TypeScript-Struktur:

```ts
const PRACTICES = [1, 2, 3];

function ojbp(ct, period) {
  const root = `ojbp_${period.key}`;

  ct.group({
    key: root,
    name: `OJBP ${period.label}`,
    groupType: "event_structure",
    parents: [],
  });

  for (const number of PRACTICES) {
    ct.group({
      key: `${root}_praktikum_${number}`,
      name: `OJBP ${number}. Praktikum ${period.label}`,
      groupType: "event_structure",
      parents: [root],
      memberFields: practiceMemberFields(),
    });
  }
}
```

Adoptierte Auto-Gruppen-Regeln oder Felddefinitionen werden dabei nicht neu
erfunden, sondern in kleine Hilfsfunktionen oder Datenkonstanten verschoben.
Referenzen innerhalb dieser Daten müssen auf die neu gebildeten logischen Keys
zeigen.

#### 5. Nur die bestehende Instanz aufrufen

```ts
ojbp(ct, { key: "2025_26", label: "2025/26" });
```

Zu diesem Zeitpunkt darf noch keine neue Jahresinstanz hinzukommen. Zuerst wird
bewiesen, dass die Funktion exakt dieselbe Sollstruktur erzeugt wie die zuvor
explizit ausgeschriebenen Deklarationen.

### 9. Der No-op-Plan ist der Refactoring-Test

**Aussage:** `ct plan --env source` übernimmt die Rolle eines semantischen
Regressionstests.

Der Prüfzyklus:

1. adoptierte Deklarationen einfügen → Plan ist No-op;
2. Literale durch Variablen ersetzen → Plan muss No-op bleiben;
3. gemeinsame Teile in Hilfsfunktionen verschieben → Plan muss No-op bleiben;
4. Hierarchie und andere bewusst fehlende Beziehungen ergänzen → Abweichung
   prüfen und danach wieder No-op herstellen;
5. erst dann den Blueprint als gewonnen betrachten.

Ein Text-Diff beweist nur, dass Code verändert wurde. Der ChurchTools-Plan
beweist, dass das Refactoring dieselbe fachliche Struktur beschreibt.

Falls der Plan nach dem Refactoring Änderungen zeigt, ist das wertvolle
Information:

- Ein Literal wurde fälschlich verallgemeinert.
- Ein Key oder eine Referenz zeigt auf die falsche Instanz.
- Ein adoptierter Teil wurde beim Extrahieren verloren.
- Die Adoption hatte eine bewusste Lücke, etwa die noch nicht automatisch
  übernommene Hierarchie.

### 10. Die API-Grenzen entsprechen nicht dem Objekt im Kopf

**Aussage:** Ein „Gruppenobjekt“ verteilt sich in ChurchTools über mehrere
Schnittstellen und unterschiedliche Semantiken.

Beispiel Gruppe:

- Grunddaten über den Gruppen-Endpunkt
- Hierarchie als separate Beziehung
- Mitgliedsfelddefinitionen als gruppeneigene Unterobjekte
- Auto-Gruppen-Regelsatz über einen weiteren Endpunkt
- Berechtigungen über eine eigene Plan-/Apply-Strecke

ct-cli faltet diese Teile für den Anwender zu einer Deklaration zusammen, ohne
ihre unterschiedliche Lifecycle-Semantik zu verschleiern. Diese Folie erklärt,
warum das Verfahren kompliziert ist, ohne in einzelne HTTP-Requests abzurutschen.

### 11. `ct plan` baut einen überprüfbaren Änderungsvorschlag

**Aussage:** `plan` liest viel, schreibt nichts und bricht lieber ab, als
Unsicherheit als Änderung zu interpretieren.

Vereinfachter Ablauf:

1. Projekt, Environment, Config und hostgebundenen State laden
2. verwaltete Live-Objekte und synthetische Teilobjekte lesen
3. logische Referenzen auflösen
4. Desired, last known und actual vergleichen
5. Änderungen und Drift nach Ursache kennzeichnen
6. Abhängigkeiten topologisch ordnen
7. strukturelle Änderungen und Berechtigungsänderungen gemeinsam ausgeben

Ein fehlgeschlagener Read ist nicht „Objekt fehlt“. Ein unvollständiger Plan
darf deshalb nicht angewendet werden.

### 12. `ct apply` führt genau den bestätigten Plan aus

**Aussage:** Zwischen Vorschlag und Ausführung gibt es eine harte
Sicherheitsgrenze.

Der Ablauf:

1. Plan vorbereiten und unveränderlich zur Bestätigung vorlegen
2. Bestätigung prüfen; bei geschützten Environments den Namen verlangen
3. sicherstellen, dass der State seit der Planung unverändert ist
4. Backup des Live-Zustands schreiben
5. Ressourcen in Abhängigkeitsreihenfolge erzeugen oder aktualisieren
6. State nach jeder erfolgreichen Aktion speichern
7. anschließend Berechtigungen anwenden
8. optional betroffene Auto-Gruppen gezielt aktualisieren

`apply` löscht nie. Löschen ist ein eigener, explizit adressierter Vorgang über
`destroy --target` und läuft in umgekehrter Abhängigkeitsreihenfolge.

### 13. Safety ist kein Prompt, sondern das Systemdesign

**Aussage:** Die Schutzwirkung entsteht aus mehreren unabhängigen Invarianten.

- Nur deklarierte oder adoptierte Objekte sind sichtbar.
- State-Dateien sind an einen Host gebunden.
- Geschützte Environments verlangen eine nicht umgehbare Bestätigung.
- Vor Änderungen wird ein Backup erzeugt.
- State wird schrittweise gespeichert; ein Lauf ist fortsetzbar.
- Löschen ist nie implizit.
- `preventDestroy` kann selbst explizites Löschen sperren.
- Personenbezogene Schreibpfade sind im Code ausgeschlossen.

Nicht alle Punkte einzeln erklären. Zwei oder drei davon an einem realen
Fehlerszenario demonstrieren.

### 14. Wiederholung wird zu normalem TypeScript

**Aussage:** Ein Blueprint ist kein Spezialformat, sondern eine Funktion über
den bestehenden DSL-Kontext.

Ein kurzes Beispiel mit `kidsArea(ct, "mainz")` und
`kidsArea(ct, "berlin")` zeigt:

- gleiche Struktur, unterschiedliche Parameter
- automatisch eindeutige Keys
- Referenzen bleiben pro Campus lokal
- Reihenfolge ergibt sich aus Abhängigkeiten, nicht aus Handarbeit

Die Folie beantwortet die Frage: „Was gewinnt man jenseits eines einmaligen
Imports?“

### 15. Live-Demo: vom bestehenden System zum wiederverwendbaren Blueprint

**Aussage:** ct-cli kann aus einem real existierenden ChurchTools-Konstrukt
einen reproduzierbaren Baustein machen, der auf einem anderen System und für
ein weiteres Jahr erneut ausgerollt wird.

Die Demo ist der Höhepunkt des Vortrags und besteht aus vier klar getrennten
Akten.

#### Akt 1: Das vorhandene Konstrukt adoptieren

Ausgangspunkt ist ein bereits produktiv genutzter Gruppenbaum, zum Beispiel:

```text
OJBP 2025/26
├── 1. Praktikum 25/26
├── 2. Praktikum 25/26
└── 3. Praktikum 25/26
```

Zuerst die Wurzel bewusst übernehmen, danach den vollständigen Teilbaum. Im
aktuellen CLI-Stand schließt `--children-of` die Wurzel selbst nicht ein:

```bash
ct adopt group <root-id> \
  --env source \
  --key ojbp_2025_26 \
  --with-member-fields \
  --with-dynamic

ct adopt group \
  --children-of ojbp_2025_26 \
  --env source \
  --with-member-fields \
  --with-dynamic
```

An der Ausgabe zeigen:

- Live-IDs landen im State, nicht als Identität im Blueprint.
- Gruppe, Gruppentyp und Campus werden möglichst in logische Referenzen
  übersetzt.
- Mitgliedsfelddefinitionen enthalten keine hostgebundenen Feld-IDs.
- Auto-Gruppen-Regelsätze werden soweit möglich portabilisiert.
- Personen und Mitgliedschaften werden nicht gelesen.

Die erzeugten Deklarationen werden in die Config übernommen. Ein anschließendes
`ct plan --env source` sollte für alle tatsächlich erfassten Felder ein No-op
sein: Adoption verändert ChurchTools nicht, sie übernimmt Verantwortung für
den vorgefundenen Zustand.

#### Akt 2: Aus dem Snapshot wird schrittweise ein Blueprint

Die adoptierte Ausgabe beschreibt zunächst das konkrete Jahr. Dieser Akt ist
der längste und wichtigste Teil der Demo. Das Refactoring in kleinen,
überprüfbaren Schritten zeigen:

1. Jahreswerte im konkreten Code markieren.
2. `period.key` und `period.label` einführen.
3. ein deterministisches Key-Schema bilden.
4. wiederholte Gruppen in eine Schleife überführen.
5. gemeinsame Felder und Regeln in Hilfsfunktionen extrahieren.
6. interne Referenzen auf abgeleitete Keys umstellen.
7. nach jedem größeren Schritt gegen `source` planen.

Zielbild:

```ts
function ojbp(ct, { key, label }) {
  const root = `ojbp_${key}`;

  ct.group({
    key: root,
    name: `OJBP ${label}`,
    groupType: "event_structure",
    parents: [],
  });

  for (const number of [1, 2, 3]) {
    ct.group({
      key: `${root}_praktikum_${number}`,
      name: `OJBP ${number}. Praktikum ${label}`,
      groupType: "event_structure",
      parents: [root],
    });
  }
}

ojbp(ct, { key: "2025_26", label: "2025/26" });
```

Für die Live-Demo drei vorbereitete Git-Stände oder Dateien bereithalten:

1. rohe Adoptionsausgabe;
2. markierte beziehungsweise parametrisierte Zwischenform;
3. fertiger Blueprint.

So bleibt die Herleitung sichtbar, ohne zehn Minuten fehleranfälliges Tippen.
Der Wechsel zwischen den Ständen sollte jeweils von einem
`ct plan --env source` begleitet werden.

Aktuelle Produktgrenze offen benennen: Die Adoption des Teilbaums erfasst die
Gruppen, aber im derzeitigen Stand noch nicht automatisch dessen
`parents`-Hierarchie. Die Beziehungen werden beim Blueprint-Umbau explizit
ergänzt. Danach muss ein erneutes `ct plan --env source` wieder ein No-op sein.

Das ist kein Nebendetail, sondern eine gute Erklärung der Kernidee: Adoption
liefert nicht blind „alles Erreichbare“, sondern nur Struktur, deren Ownership
und Semantik das Projekt sicher vertreten kann.

#### Akt 3: Dasselbe Konstrukt in ein neues System bringen

Nun wird nur das Environment gewechselt; Blueprint und Checkout bleiben gleich:

```bash
ct plan  --env target
ct apply --env target
ct plan  --env target
```

Der erste Plan zeigt ausschließlich Erzeugungen. Dabei erklären:

- `target` verwendet einen anderen Host und einen eigenen State.
- logische Referenzen werden gegen die IDs des Zielsystems aufgelöst.
- der Abhängigkeitsgraph erzeugt Wurzel und Kindgruppen in richtiger Reihenfolge.
- dieselbe Config braucht keine hostbezogenen Änderungen.

Nach dem Apply muss der zweite Plan ein No-op sein. Diese Konvergenz ist der
Beweis, dass das Konstrukt reproduzierbar beschrieben wurde.

Voraussetzung vor der Demo: Gemeinsam referenzierte Stammdaten wie Gruppentypen
oder Campus müssen im Zielsystem entweder bereits unter eindeutig auflösbaren
Namen existieren oder selbst Teil der Config sein. Numerische IDs in der
adoptierten Ausgabe müssen vor der Übertragung beseitigt oder bewusst als
hostgebundene Ausnahme erklärt werden.

#### Akt 4: Die Struktur für das nächste Jahr instanziieren

Nun kommt die eigentliche Skalierung. Ein weiterer Funktionsaufruf genügt:

```ts
ojbp(ct, { key: "2025_26", label: "2025/26" });
ojbp(ct, { key: "2026_27", label: "2026/27" });
```

Dann erneut:

```bash
ct plan  --env target
ct apply --env target
ct plan  --env target
```

Der entscheidende Moment im Plan:

- Das Konstrukt 2025/26 bleibt unverändert.
- Nur die neuen Keys für 2026/27 erscheinen als Creates.
- Hierarchie, Felder und gegebenenfalls Auto-Gruppen werden aus demselben
  Blueprint erzeugt.
- Der abschließende Plan konvergiert erneut zu einem No-op.

Damit beantwortet die Demo in einem Bogen alle vier Einstiegsfragen:

- Bestehendes Wissen wird aus dem Klicksystem in Code überführt.
- Der Plan zeigt jede Änderung vor ihrer Ausführung.
- Ein neues System wird aus demselben Code aufgebaut.
- Das nächste Jahr ist eine neue Instanz statt einer Kopieraktion in der UI.

#### Demo-Absicherung

- Source nur lesen und adoptieren; dort nichts mit `apply` verändern.
- Alle schreibenden Schritte ausschließlich gegen ein Demo-/Target-System.
- Vorab `ct auth status --all` und einen vollständigen Trockenlauf durchführen.
- Eine fertige Blueprint-Datei als Rückfalloption bereithalten.
- Die erwarteten Plan-Ausgaben als Screenshots oder Textdateien sichern.
- Auto-Gruppen nur zeigen, wenn ihre Regeln vollständig portabel sind.
- Berechtigungsadoption aus der Hauptdemo herauslassen; sie kann als
  Reservefolie erklärt werden.
- Kein `destroy` in der Live-Demo.

Die alte, kürzere Demo-Variante bleibt als Rückfalloption:

1. Ausgangspunkt mit `ct plan --env dev`: keine Änderungen
2. eine kleine, sichtbare Config-Änderung vornehmen
3. `ct plan --env dev` und Herkunft der Änderung erklären
4. `ct apply --env dev`
5. erneut `ct plan --env dev`: keine Änderungen
6. optional denselben Checkout gegen Prod planen, aber nicht live anwenden

Wenn Adoption gezeigt werden soll, besser als separate vorbereitete Sequenz:

1. bestehendes Objekt bewusst adoptieren
2. erzeugten Config-Ausschnitt und State-Zuordnung zeigen
3. direkt danach ein sauberer No-op-Plan

Sie sollte nur verwendet werden, wenn das zweite System am Abend nicht sicher
verfügbar ist.

### 16. Die ehrlichen Grenzen gehören zum Produkt

**Aussage:** Reproduzierbarkeit heißt auch, manuelle und ausgeschlossene
Flächen sichtbar zu benennen.

Drei verschiedene Arten von Grenzen auseinanderhalten:

- ChurchTools bietet keinen von ct-cli nutzbaren Schreibpfad.
- Der Schreibpfad existiert, ist in ct-cli aber noch nicht implementiert.
- Das Thema liegt absichtlich außerhalb des Produkts.

Das verhindert, dass „noch nicht gebaut“, „technisch unmöglich“ und „bewusst
nicht gewollt“ miteinander verwechselt werden.

### 17. Schluss: ChurchTools-Struktur wird zu überprüfbarem Code

**Aussage:** ct-cli überträgt den entscheidenden Wert von Terraform auf
ChurchTools: Nicht die Ausführung steht im Mittelpunkt, sondern ein
versionierter Sollzustand und ein überprüfbarer Weg dorthin.

Rückbindung an die Einstiegsfragen:

- Git beantwortet „wer und warum“.
- logische Referenzen und Environments ermöglichen Portabilität.
- `plan` macht die Änderung vorab sichtbar.
- State und Adoption machen Ownership explizit.
- Guardrails begrenzen den möglichen Schaden.
- Blueprints machen aus einer übernommenen Jahresstruktur einen
  wiederverwendbaren Baustein.

Möglicher letzter Satz:

> Was Terraform für Infrastruktur etabliert hat, bringt ct-cli in die
> ChurchTools-Konfiguration: Änderungen werden zu Code, zu einem Plan und zu
> einem reproduzierbaren Prozess.

## Demo- und Erzählstrategie

Die Erklärung sollte stets dieselben drei Ebenen auseinanderhalten:

- **Modell:** Was soll gelten?
- **Mechanik:** Wie berechnet und ordnet ct-cli die Änderung?
- **Garantie:** Welche gefährliche Fehlinterpretation verhindert das?

Beispiel: Bei einem fehlgeschlagenen API-Read nicht nur Retry-Verhalten
erklären. Die eigentliche Garantie lautet: Ein Lesefehler wird niemals als
verschwundenes Objekt und damit als Anlass zur Neuerzeugung interpretiert.

Für den Vortrag genügen zwei durchgehende Beispielobjekte:

- Jahreswurzel `ojbp_2025_26`
- Kindgruppen `ojbp_2025_26_praktikum_1` bis `_3`

Mit dem gleichen Konstrukt lassen sich Keys, Referenzen, Hierarchie,
Mitgliedsfelder, Adoption, Plan, Apply, Portabilität und Blueprints erklären.
Weitere Domänen nur erwähnen, wenn sie eine neue Semantik zeigen.

## Reservefolien für Fragen

Diese Inhalte sind für ein technisches Publikum wertvoll, aber nicht Teil der
Hauptgeschichte:

1. State-Datei: Schema, Host-Bindung und last-known Snapshot
2. Abhängigkeitsgraph und Apply-Reihenfolge
3. Berechtigungsmodell: Domains, Scopes und Katalog
4. Auto-Gruppen: Ruleset, Status und gezielter Refresh
5. Adoption-Vertrag mit allen fünf Kategorien
6. Dev→Prod-Promotion und CI-Ausgaben
7. API-Archäologie und manuelle Oberfläche
8. Aktueller Stand und nächste Schritte
9. Blueprint-Refactoring als Vorher/Zwischenstand/Nachher-Diff

## Noch zu vervollständigen

- [ ] Exakte Vortragsdauer und gewünschter Anteil für Fragen
- [ ] Konkreter Kontext der Zuhörer: ChurchTools-Erfahrung oder nur
      allgemeiner Infrastruktur-/Software-Hintergrund
- [ ] Ein reales Beispiel aus der Organisation als roter Faden
- [ ] Source- und Target-Environment festlegen und Zugänge vorab prüfen
- [ ] Konkrete Wurzelgruppe und den erwarteten Teilbaum dokumentieren
- [ ] Prüfen, welche Gruppen Auto-Regeln und Mitgliedsfelder besitzen
- [ ] Verbleibende numerische IDs in der Adoptionsausgabe identifizieren
- [ ] Gruppentypen, Campus und andere Referenzen im Target vorbereiten oder
      deklarieren
- [ ] Blueprint-Umbau vorbereiten; live nur die Parametrisierung zeigen
- [ ] Drei demonstrierbare Blueprint-Stände vorbereiten: roh, parametrisiert,
      extrahiert
- [ ] Für jeden Refactoring-Schritt den erwarteten Source-Plan festhalten
- [ ] Erwartete Pläne und Rückfall-Screenshots sichern
- [ ] Zwei bis drei konkrete Zahlen ergänzen, falls sie verfügbar sind
      (verwaltete Objekte, Campuses, typische Plan-Größe)
- [ ] Aktuellen Produktstand und Roadmap-Punkte auswählen
- [ ] Folienformat und visuelle Richtung festlegen
