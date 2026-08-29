import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT_DIR = "/Users/beweiche/beweiche_noTimeMachine/ct-cli/.tmp/ct-cli-kurzdeck/output";
const FINAL = "/Users/beweiche/beweiche_noTimeMachine/ct-cli/ct-cli-kurzpraesentation.pptx";
const SOURCE_CT = "/Users/beweiche/beweiche_noTimeMachine/ct-cli/README.md";
const SOURCE_CASE = "/Users/beweiche/beweiche_noTimeMachine/114_bgkt_ct_masterdata/churchtools-processes/docs/fallstudie-ojbp-vom-bestand-zum-blueprint.md";
const SOURCE_OJBP = "/Users/beweiche/beweiche_noTimeMachine/114_bgkt_ct_masterdata/churchtools-processes/processes/ojbp/README.md";
const SOURCE_BLUEPRINT = "/Users/beweiche/beweiche_noTimeMachine/114_bgkt_ct_masterdata/churchtools-processes/processes/ojbp/blueprint/ojbp.ts";

const C = {
  ink: "#000000",
  canvas: "#FFFFFF",
  panel: "#EDEDED",
  panelSoft: "#F6F6F6",
  rule: "#B8BCC4",
  accent: "#6DCBF4",
  accentStrong: "#3D8DFF",
  muted: "#555B66",
};

const FONT = "Helvetica Neue";
const MONO = "Menlo";

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function box(slide, name, position, fill = "none", lineFill = "none", lineWidth = 0, geometry = "rect") {
  return slide.shapes.add({
    geometry,
    name,
    position,
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
  });
}

function text(slide, name, value, position, style = {}) {
  const shape = box(slide, name, position);
  shape.text = value;
  shape.text.style = {
    fontSize: style.fontSize ?? 28,
    typeface: style.typeface ?? FONT,
    color: style.color ?? C.ink,
    bold: style.bold ?? false,
    alignment: style.alignment ?? "left",
    verticalAlignment: style.verticalAlignment ?? "top",
    autoFit: style.autoFit ?? "shrinkText",
    wrap: "square",
    ...style,
  };
  return shape;
}

function rule(slide, name, left, top, width, fill = C.rule, height = 2) {
  return box(slide, name, { left, top, width, height }, fill);
}

function title(slide, value, number) {
  text(slide, `slide-${number}-title`, value, { left: 42, top: 34, width: 1170, height: 90 }, {
    fontSize: 40,
    bold: false,
    autoFit: "none",
  });
  text(slide, `slide-${number}-number`, String(number), { left: 1180, top: 660, width: 55, height: 22 }, {
    fontSize: 14,
    alignment: "right",
    verticalAlignment: "bottom",
    color: C.muted,
    autoFit: "none",
  });
}

function notes(slide, lines, sources) {
  slide.speakerNotes.textFrame.setText([
    ...lines,
    "",
    "[Sources]",
    ...sources.map((s) => `- ${s}`),
    "[/Sources]",
  ]);
  slide.speakerNotes.setVisible(true);
}

const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

// 1 — Opening thesis.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  text(slide, "s1-eyebrow", "ct-cli · Fallstudie OJBP", { left: 42, top: 42, width: 620, height: 46 }, { fontSize: 24, color: C.muted, autoFit: "none" });
  rule(slide, "s1-accent", 42, 132, 190, C.accentStrong, 8);
  text(slide, "s1-title", "ChurchTools\nConfiguration as Code", { left: 42, top: 178, width: 1030, height: 270 }, { fontSize: 78, verticalAlignment: "bottom", autoFit: "none" });
  text(slide, "s1-subtitle", "Vom erprobten Prozess zum wiederholbaren Soll-Zustand", { left: 42, top: 505, width: 930, height: 78 }, { fontSize: 30, color: C.muted, autoFit: "none" });
  notes(slide, [
    "Die Terraform-Analogie ist nicht nur 'Konfiguration liegt in Git'. Entscheidend ist der vollständige Zyklus vom realen System zum überprüften Soll-Zustand.",
    "Die OJBP-Reise zeigt zugleich, wo ct-cli heute stark ist und wo noch eine große Lücke liegt.",
  ], [SOURCE_CT, SOURCE_CASE]);
}

// 2 — The complete five-step loop.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "Der Weg zum Blueprint hat fünf verschiedene Aufgaben", 2);
  rule(slide, "s2-flow", 105, 312, 1040, C.ink, 2);
  const steps = [
    ["1", "ERPROBEN", "Prozess manuell\nzum Laufen bringen"],
    ["2", "ADOPT", "Elemente als\nState erfassen"],
    ["3", "BLUEPRINT", "Blueprint für neue\nInkarnationen gewinnen"],
    ["4", "PLAN", "Ist und Soll\nvergleichen"],
    ["5", "APPLY", "geprüften Plan\numsetzen"],
  ];
  steps.forEach((s, i) => {
    const x = 45 + i * 238;
    box(slide, `s2-node-${i}`, { left: x + 45, top: 292, width: 42, height: 42 }, i === 2 ? C.accentStrong : C.ink, "none", 0, "ellipse");
    text(slide, `s2-num-${i}`, s[0], { left: x + 45, top: 298, width: 42, height: 28 }, { fontSize: 18, bold: true, color: C.canvas, alignment: "center", autoFit: "none" });
    text(slide, `s2-label-${i}`, s[1], { left: x + 10, top: 214, width: 160, height: 32 }, { fontSize: 14, bold: true, color: i === 2 ? C.accentStrong : C.muted, alignment: "center", autoFit: "none" });
    text(slide, `s2-body-${i}`, s[2], { left: x + 10, top: 370, width: 160, height: 105 }, { fontSize: 17, alignment: "center", color: C.muted, autoFit: "none" });
  });
  text(slide, "s2-callout", "Schritt 3 ist keine Kopieroperation, sondern Modellierungsarbeit.", { left: 180, top: 548, width: 920, height: 70 }, { fontSize: 26, alignment: "center", autoFit: "none" });
  notes(slide, [
    "Die fünf Schritte sind bewusst getrennt. Das manuelle Erproben entdeckt den fachlichen Prozess. Adoption dokumentiert den konkreten Bestand. Erst danach entsteht ein wiederverwendbares Modell.",
    "Der schwierige Sprung ist von Schritt 2 zu Schritt 3.",
  ], [SOURCE_CASE]);
}

// 3 — Manual process first.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "1 · Zuerst muss der Prozess fachlich funktionieren", 3);
  box(slide, "s3-tree-panel", { left: 42, top: 165, width: 560, height: 430 }, C.panelSoft);
  text(slide, "s3-tree", "OJBP 2025/26\n│\n├─ Übersicht\n├─ 1. Praktikum\n├─ 2. Praktikum\n└─ 3. Praktikum", { left: 78, top: 205, width: 480, height: 330 }, { fontSize: 32, typeface: MONO, autoFit: "none" });
  text(slide, "s3-main", "Klicken ist hier\nkein Fehler.", { left: 665, top: 176, width: 500, height: 165 }, { fontSize: 52, autoFit: "none" });
  rule(slide, "s3-accent", 665, 374, 170, C.accentStrong, 7);
  text(slide, "s3-copy", "Der erste Jahrgang ist ein Prototyp:\nStruktur, Felder und Regeln werden\nim echten Betrieb verstanden.", { left: 665, top: 412, width: 500, height: 150 }, { fontSize: 26, color: C.muted, autoFit: "none" });
  notes(slide, [
    "Infrastructure as Code ersetzt nicht die fachliche Exploration. Ein neuer Prozess wird häufig zunächst manuell aufgebaut und im echten Betrieb korrigiert.",
    "OJBP bestand sichtbar aus vier Gruppen, tatsächlich aber zusätzlich aus Hierarchie, Mitgliedsfelddefinitionen und dynamischen Regeln.",
  ], [SOURCE_CASE, SOURCE_OJBP]);
}

// 4 — Adoption captures concrete state.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "2 · Adoption macht den konkreten Bestand sichtbar", 4);
  box(slide, "s4-left", { left: 42, top: 160, width: 430, height: 430 }, C.panelSoft);
  text(slide, "s4-live", "LIVE-SYSTEM", { left: 76, top: 205, width: 330, height: 34 }, { fontSize: 18, bold: true, color: C.muted, autoFit: "none" });
  text(slide, "s4-live-list", "4 Gruppen\n36 Mitgliedsfelder\n4 dynamische Rulesets\nkonkrete IDs", { left: 76, top: 270, width: 330, height: 235 }, { fontSize: 31, autoFit: "none" });
  text(slide, "s4-arrow", "→", { left: 500, top: 310, width: 90, height: 80 }, { fontSize: 56, alignment: "center", color: C.accentStrong, autoFit: "none" });
  box(slide, "s4-right", { left: 620, top: 160, width: 618, height: 430 }, "#DFF3FC");
  text(slide, "s4-code-label", "ADOPTIERTE DEKLARATIONEN", { left: 660, top: 205, width: 510, height: 34 }, { fontSize: 18, bold: true, color: C.accentStrong, autoFit: "none" });
  text(slide, "s4-code", "group({ id: 4711,\n  name: \"OJBP 2025/26\",\n  parentId: 123, ... })", { left: 660, top: 270, width: 520, height: 190 }, { fontSize: 29, typeface: MONO, autoFit: "none" });
  text(slide, "s4-bottom", "Adoption erhält Fakten – einschließlich ihrer Zufälligkeiten.", { left: 660, top: 500, width: 520, height: 58 }, { fontSize: 24, color: C.muted, autoFit: "none" });
  notes(slide, [
    "Adoption liest ausgewählte ChurchTools-Ressourcen und erzeugt konkrete Deklarationen. Das ist bereits wertvoll: Der Bestand wird sichtbar, versionierbar und planbar.",
    "Aber diese Deklarationen enthalten hostgebundene IDs, Jahreszahlen und historische Entscheidungen. Sie sind State, noch kein Blueprint.",
  ], [SOURCE_CASE, SOURCE_CT]);
}

// 5 — Core distinction: state is not a blueprint.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "3 · Ein kopierter State ist noch kein Blueprint", 5);
  text(slide, "s5-state", "State", { left: 92, top: 205, width: 300, height: 100 }, { fontSize: 64, alignment: "center", autoFit: "none" });
  text(slide, "s5-not-eq", "≠", { left: 485, top: 205, width: 250, height: 100 }, { fontSize: 76, alignment: "center", color: C.accentStrong, autoFit: "none" });
  text(slide, "s5-blueprint", "Blueprint", { left: 825, top: 205, width: 330, height: 100 }, { fontSize: 64, alignment: "center", autoFit: "none" });
  rule(slide, "s5-rule", 85, 350, 1090, C.rule, 2);
  text(slide, "s5-left", "konkrete IDs\n2025/26 im Namen\nzufällige Reihenfolge\nHost-Referenzen", { left: 120, top: 390, width: 350, height: 180 }, { fontSize: 27, color: C.muted, alignment: "center", autoFit: "none" });
  text(slide, "s5-right", "stabile Invarianten\nJahr als Parameter\nlogische Referenzen\nberechnete Werte", { left: 760, top: 390, width: 400, height: 180 }, { fontSize: 27, color: C.muted, alignment: "center", autoFit: "none" });
  text(slide, "s5-callout", "Genau diesen Übersetzungsschritt automatisiert ct-cli heute noch nicht autonom.", { left: 190, top: 610, width: 900, height: 42 }, { fontSize: 25, alignment: "center", autoFit: "none" });
  notes(slide, [
    "Das ist die zentrale Baustelle. Kopiert man nur den State, kopiert man auch IDs und zufällige Details des Quellsystems.",
    "Ein Blueprint beantwortet dagegen: Was bleibt gleich? Was wird Parameter? Welche Referenzen müssen logisch statt numerisch sein? Was wird berechnet?",
    "ct-cli liefert dafür heute keine vollautomatische Transformation.",
  ], [SOURCE_CASE, SOURCE_BLUEPRINT]);
}

// 6 — How an agent helps with blueprint extraction.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "Der Coding-Agent kann die Abstraktion vorbereiten", 6);
  const cols = [42, 450, 858];
  const items = [
    ["INVARIANTEN", "Welche Gruppen,\nFelder und Regeln\ngehören immer dazu?"],
    ["PARAMETER", "Was ändert sich je\nJahrgang oder\nZielsystem?"],
    ["REFERENZEN", "Welche IDs werden\nzu Namen und\nBeziehungen?"],
  ];
  items.forEach((it, i) => {
    box(slide, `s6-panel-${i}`, { left: cols[i], top: 176, width: 350, height: 300 }, i === 1 ? "#DFF3FC" : C.panelSoft);
    text(slide, `s6-head-${i}`, it[0], { left: cols[i] + 28, top: 215, width: 294, height: 35 }, { fontSize: 18, bold: true, color: i === 1 ? C.accentStrong : C.muted, autoFit: "none" });
    text(slide, `s6-body-${i}`, it[1], { left: cols[i] + 28, top: 285, width: 294, height: 145 }, { fontSize: 24, autoFit: "none" });
  });
  text(slide, "s6-code", 'defineOjbp(ct, ["26/27", "27/28"]);', { left: 245, top: 520, width: 790, height: 58 }, { fontSize: 26, typeface: MONO, alignment: "center", autoFit: "none" });
  text(slide, "s6-boundary", "Der Agent schlägt das Modell vor. Der Mensch bestätigt die fachliche Absicht.", { left: 155, top: 600, width: 970, height: 48 }, { fontSize: 22, alignment: "center", color: C.muted, autoFit: "none" });
  notes(slide, [
    "Im OJBP-Projekt hat der Coding-Agent genau diese Analyse über die adoptierten Deklarationen und die begleitende Konversation durchgeführt.",
    "Das Ergebnis war eine parametrisierte TypeScript-Funktion. Der Agent war hilfreich, weil die Aufgabe semantisch ist – aber sein Entwurf ist noch kein Beweis.",
  ], [SOURCE_CASE, SOURCE_BLUEPRINT]);
}

// 7 — Plan as deterministic comparison.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "4 · Der Plan macht die Abstraktion überprüfbar", 7);
  box(slide, "s7-current", { left: 52, top: 175, width: 360, height: 235 }, C.panelSoft);
  text(slide, "s7-current-head", "IST-ZUSTAND", { left: 84, top: 215, width: 295, height: 32 }, { fontSize: 18, bold: true, color: C.muted, autoFit: "none" });
  text(slide, "s7-current-body", "ChurchTools\nLive-System", { left: 84, top: 285, width: 295, height: 90 }, { fontSize: 34, autoFit: "none" });
  box(slide, "s7-desired", { left: 868, top: 175, width: 360, height: 235 }, "#DFF3FC");
  text(slide, "s7-desired-head", "SOLL-ZUSTAND", { left: 900, top: 215, width: 295, height: 32 }, { fontSize: 18, bold: true, color: C.accentStrong, autoFit: "none" });
  text(slide, "s7-desired-body", "Blueprint +\nParameter", { left: 900, top: 285, width: 295, height: 90 }, { fontSize: 34, autoFit: "none" });
  text(slide, "s7-arrow-l", "→", { left: 430, top: 245, width: 95, height: 80 }, { fontSize: 56, alignment: "center", autoFit: "none" });
  text(slide, "s7-plan", "ct plan", { left: 520, top: 245, width: 240, height: 80 }, { fontSize: 46, bold: true, alignment: "center", autoFit: "none" });
  text(slide, "s7-arrow-r", "←", { left: 755, top: 245, width: 95, height: 80 }, { fontSize: 56, alignment: "center", autoFit: "none" });
  box(slide, "s7-result", { left: 225, top: 485, width: 830, height: 110 }, C.ink);
  text(slide, "s7-result-text", "+ create    ~ update    = no-op", { left: 265, top: 518, width: 750, height: 48 }, { fontSize: 28, typeface: MONO, color: C.canvas, alignment: "center", autoFit: "none" });
  notes(slide, [
    "Plan ist die deterministische Vertrauensgrenze. Er vergleicht den gewünschten Zustand aus Code mit dem tatsächlichen ChurchTools-System.",
    "Hier wird sichtbar, ob die Agenten-Abstraktion wirklich nur die erwarteten Creates und Updates erzeugt – oder unbeabsichtigte Änderungen enthält.",
  ], [SOURCE_CT, SOURCE_CASE]);
}

// 8 — Apply and convergence.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  title(slide, "5 · Apply setzt nur den geprüften Plan um", 8);
  text(slide, "s8-plan", "PLAN", { left: 90, top: 205, width: 250, height: 60 }, { fontSize: 20, bold: true, color: C.muted, alignment: "center", autoFit: "none" });
  text(slide, "s8-plan-body", "4 Gruppen\n36 Mitgliedsfelder\n4 Rulesets", { left: 90, top: 285, width: 250, height: 150 }, { fontSize: 29, alignment: "center", autoFit: "none" });
  text(slide, "s8-arrow1", "→", { left: 355, top: 320, width: 100, height: 70 }, { fontSize: 56, alignment: "center", color: C.accentStrong, autoFit: "none" });
  box(slide, "s8-apply", { left: 465, top: 225, width: 330, height: 230 }, C.ink);
  text(slide, "s8-apply-text", "ct apply", { left: 500, top: 305, width: 260, height: 70 }, { fontSize: 46, bold: true, color: C.canvas, alignment: "center", autoFit: "none" });
  text(slide, "s8-arrow2", "→", { left: 805, top: 320, width: 100, height: 70 }, { fontSize: 56, alignment: "center", color: C.accentStrong, autoFit: "none" });
  text(slide, "s8-after", "FOLGEPLAN", { left: 930, top: 205, width: 250, height: 60 }, { fontSize: 20, bold: true, color: C.muted, alignment: "center", autoFit: "none" });
  text(slide, "s8-value", "49", { left: 930, top: 270, width: 250, height: 110 }, { fontSize: 78, color: C.accentStrong, alignment: "center", autoFit: "none" });
  text(slide, "s8-noops", "No-ops", { left: 930, top: 390, width: 250, height: 55 }, { fontSize: 30, alignment: "center", autoFit: "none" });
  text(slide, "s8-thesis", "Konvergenz ist der Beweis: Nach Apply gibt es nichts mehr zu ändern.", { left: 175, top: 570, width: 930, height: 52 }, { fontSize: 28, alignment: "center", autoFit: "none" });
  notes(slide, [
    "Apply führt den zuvor geprüften Plan aus. Danach wird erneut geplant.",
    "Im Test auf dem zweiten Host ergab der vollständige Folgeplan 49 No-ops. Das ist der praktische Beleg für Idempotenz und Portabilität.",
  ], [SOURCE_CASE, SOURCE_OJBP]);
}

// 9 — Close with the reusable loop.
{
  const slide = presentation.slides.add();
  slide.background.fill = C.canvas;
  text(slide, "s9-eyebrow", "Die eigentliche Erkenntnis", { left: 42, top: 42, width: 620, height: 46 }, { fontSize: 24, color: C.muted, autoFit: "none" });
  text(slide, "s9-main", "Adoptieren erfasst.\nAbstrahieren macht wiederholbar.\nPlanen schafft Vertrauen.", { left: 42, top: 145, width: 1120, height: 315 }, { fontSize: 55, verticalAlignment: "bottom", autoFit: "none" });
  rule(slide, "s9-accent", 42, 492, 210, C.accentStrong, 8);
  box(slide, "s9-code-panel", { left: 42, top: 540, width: 760, height: 86 }, C.panelSoft);
  text(slide, "s9-code", 'defineOjbp(ct, ["26/27", "27/28"]);', { left: 68, top: 565, width: 700, height: 42 }, { fontSize: 27, typeface: MONO, autoFit: "none" });
  text(slide, "s9-close", "Das nächste Jahr wird ein Parameter – nicht wieder Klickarbeit.", { left: 835, top: 544, width: 365, height: 86 }, { fontSize: 23, color: C.muted, autoFit: "none" });
  notes(slide, [
    "Die Lücke ist nun präzise benannt: ct-cli kann adoptieren, planen und anwenden. Die semantische Transformation vom konkreten State zum Blueprint braucht derzeit menschliche oder agentische Modellierungsarbeit.",
    "Die sichere Arbeitsteilung lautet: Der Agent abstrahiert. Der Mensch bestätigt die Absicht. Der Plan beweist die Auswirkung.",
  ], [SOURCE_CASE, SOURCE_BLUEPRINT]);
}

await fs.mkdir(OUT_DIR, { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(`${OUT_DIR}/${stem}.png`, await presentation.export({ slide, format: "png", scale: 2 }));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${OUT_DIR}/${stem}.layout.json`, await layout.text());
}

await writeBlob(`${OUT_DIR}/montage.webp`, await presentation.export({ format: "webp", montage: true, scale: 1 }));
const inspect = await presentation.inspect({ kind: "slide,textbox,shape,notes", maxChars: 24000 });
await fs.writeFile(`${OUT_DIR}/inspect.ndjson`, inspect.ndjson);

const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(FINAL);

console.log(FINAL);
