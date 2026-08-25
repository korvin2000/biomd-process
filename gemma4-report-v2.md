# Gemma4-31B — Sampling-Bakeoff `top_p` × `top_k` × `min_p`

**Endpoint** `local` — `http://192.168.1.26:8080/v1` (llama.cpp `b10217-ddd4ec142`, **ein** Slot)
**Modell** `gemma4-31b-local` = `unsloth/gemma-4-31B-it-qat-GGUF`, `UD-Q4_K_XL`, `n_ctx 65536` (trainiert 262 144)
**Aufgabe** `translate`, `mode: segments`, `ru → de` · **Dokument** `example/example.bio.md` (11 870 Zeichen)
**Datum** 2026-08-24 · **Temperature fix 0.75**
**114 Läufe**: 36 Kombinationen × 2 Pässe (Grid) + 42 Läufe gepaarte Nachprüfung (Abschnitt 5.4)
Gewichtung wie gefordert: **0.70 Übersetzungsqualität + 0.30 Instruktionstreue**

> Der Vorgängerbericht (Temperature-Studie, 16 Kombinationen) liegt unverändert als
> [`gemma4-report.temperature.md`](gemma4-report.temperature.md).

---

## 1. Empfehlung

```yaml
# biomd.config.yaml — llm.models
- id: local-small
  endpoint: local
  model: gemma4-31b-local
  contextWindow: 65536
  maxOutputTokens: 18432
  capabilities: [json_schema, json_object, prompt_cache]
  params:
    temperature: 0.75
    topP: 0.915
    extra: { top_k: 64, min_p: 0.04 }
```

**Diese Konfiguration ist so gut wie jede andere im getesteten Bereich — und das ist das eigentliche
Ergebnis.** Nach 114 Läufen lautet die belastbare Aussage: **keiner der drei Regler unterscheidet die
Ausgabequalität in den getesteten Bereichen verlässlich.** Die Streuung von Lauf zu Lauf ist größer als
jeder Unterschied zwischen den Einstellungen.

| Regler | getesteter Bereich | Befund |
|---|---|---|
| `top_k` | 60 – 66 | **wirkungslos**, mechanisch belegt: in 16 von 18 Fällen byte-identische Ausgabe (Abschnitt 5.1) |
| `min_p` | 0.02 – 0.06 | **gleichgültig**, gepaart über 12 Seeds widerlegt (Abschnitt 5.4). Der Regler verändert den Text, aber nicht seine Güte |
| `top_p` | 0.90 – 0.93 | **nicht belegt.** Der scheinbare Zielkonflikt hielt der Nachprüfung nicht stand (Abschnitt 5.4) |

Die angegebenen Werte sind deshalb eine Empfehlung im schwachen Sinn: sie liegen in der Mitte des
Getesteten, dicht an den Server-Defaults, und nichts spricht gegen sie. **Wer die Übersetzung verbessern
will, muss am Prompt arbeiten, nicht am Sampling** — die stabilen Defekte sind alle prompt- oder
modellseitig (Abschnitte 7 und 8):

- Regel 7 (romanisierter Name + Glosse) greift bei **jeder** Einstellung unzuverlässig — bei fest
  `top_p 0.915` in 5 von 18 Läufen, also rund 28 %. Das ist ein Prompt-Problem, kein Sampling-Problem.
- `МГУКИ` → „MGU KI", `Семочкин` → „Semotschin" und die gemischten Umschriftsysteme
  (`Otečestwennye`: wissenschaftliches `č` neben deutschem `w`) treten quer über alle Einstellungen auf.
  Der Prompt sagt „romanisieren", nennt aber kein System.
- Der einzige katastrophale Ausfall der ganzen Studie — ein kyrillisch stehengelassener Nachname
  `ЧУДИНОВ` — ist **seedgebunden**, nicht parametergebunden: derselbe Seed (20260824) produziert ihn
  sowohl bei `min_p 0.02` als auch bei `min_p 0.06`, während elf andere Seeds ihn bei keiner Einstellung
  zeigen. Gegen so etwas hilft nur die Strukturprüfung der Pipeline — und ein Guard auf kyrillische
  Reste, den es noch nicht gibt.

**Was zur Rangliste in Abschnitt 4 gehört:** ihre Spannweite beträgt 76.6 – 86.0, die mittlere Abweichung
*derselben* Zelle zwischen zwei Pässen aber 4.2 Punkte (Maximum 10.7). Sie ist als Messprotokoll
dokumentiert, **nicht als Rangfolge, auf die man sich verlassen sollte**: die Nachprüfung in Abschnitt 5.4
hat ihre beiden Hauptaussagen widerlegt.

---

## 2. Lassen sich die Parameter setzen — und greifen sie wirklich?

Zwei getrennte Fragen, beide mit Ja beantwortet, auf zwei verschiedenen Wegen belegt.

### 2.1 Die Pipeline legt sie auf die Leitung

`temperature` und `topP` sind erstklassige Felder in `src/config/schema.ts`. **`top_k` und `min_p` sind
keine OpenAI-Felder** und müssen über `params.extra` reisen, das `OpenAiCompatibleClient.buildBody`
unverändert auf den Request-Body legt.

Nachgewiesen mit einem mitschreibenden Reverse-Proxy vor dem Endpoint (`bakeoff/proxy.py`,
`127.0.0.1:8099 → 192.168.1.26:8080`). Was tatsächlich über die Leitung ging:

```json
{"model":"gemma4-31b-local","temperature":0.75,"top_p":0.9,"top_k":64,"min_p":0.05,
 "seed":42,"max_tokens":18432,"stream":false,"response_format":{"type":"json_object"}}
```

Über alle 36 Zellen geprüft: **36 verschiedene Parametersätze, keiner fehlt**, Temperature konstant
`0.75`, `response_format: json_object` bei jedem Request.

### 2.2 Der Server wendet sie an

Das ist nicht dasselbe und musste eigens gezeigt werden, denn zwei naheliegende Prüfwege tragen nicht:

- llama.cpp **validiert diese Felder nicht**. `top_k: -5`, `min_p: 2.0`, `top_p: 5.0` und ein frei
  erfundenes `nonsense_param` werden alle mit `200` angenommen. Eine Ablehnung ist also kein Nachweis.
- `top_logprobs` misst **vor** dem Sampling. Bei `top_k: 3` kommen weiterhin 5 Kandidaten zurück.

Der Nachweis läuft daher über das Verhalten. Bei `temperature 2.0` und *unbeschränkter* Kandidatenmenge
zerfällt die Ausgabe — drei Läufe, drei verschiedene Ergebnisse, darunter ein Server-`500`
(*"model produced output that does not match the expected peg-gemma4 format"*) und offenes Kauderwelsch
(„Die Gitarre ist ein vielseitiges Saitenstrument. Passengers rest ordinary facilities to routers … 今天ण
instrument. मलयाಿಸಲ").

Wird bei gleicher Temperature **je ein einzelner** der drei Parameter scharf gestellt, kollabiert die
Verteilung sofort auf sinnvollen, reproduzierbaren Text:

| Beschränkung (bei `temperature 2.0`) | Läufe | verschiedene Ergebnisse | Ausgabe |
|---|---|---|---|
| keine (`top_k 0`, `top_p 1.0`, `min_p 0.0`) | 3 | **3** | Kauderwelsch + ein `500` |
| `top_k = 1` | 3 | **1** | „Die Gitarre ist ein vielseitiges Saiteninstrument." |
| `top_p = 0.02` | 3 | **1** | „Die Gitarre ist ein vielseitiges Saiteninstrument." |
| `min_p = 0.9` | 3 | **2** | „Gitarren sind vielseitige Saiteninstrumente." |

Jeder der drei Regler verändert also für sich allein das Ergebnis — sie werden angewendet.

**Ein Detail, das die ganze Auswertung erklärt:** die Sampler-Kette des Servers (`/props`) lautet

```
penalties → dry → top_n_sigma → top_k → typ_p → top_p → min_p → xtc → temperature
```

`top_k`, `top_p` und `min_p` filtern **vor** der Temperature, in genau dieser Reihenfolge — `top_k`
zuerst. Server-Defaults: `temperature 0.75, top_k 64, top_p 0.95, min_p 0.05`.

### 2.3 Die geforderten Modes

| Mode | Ergebnis |
|---|---|
| `json_object` | ✅ `{"stadt": "Madrid"}` auf `response_format: {"type":"json_object"}` |
| `json_schema` | ✅ `{"stadt": "Madrid"}` auf ein `strict`-Schema mit `additionalProperties: false` |
| `prompt_cache` | ✅ `usage.prompt_tokens_details.cached_tokens > 0`; in den Produktionsläufen **3.7k von 5.7k** Eingabe-Token aus dem Cache |

Die Deklaration `capabilities: [json_schema, json_object, prompt_cache]` in `biomd.config.yaml` ist für
dieses Modell **korrekt und vollständig belegt**.

**Nebenbefund mit Kostenfolge:** das Modell **denkt von sich aus** — es öffnet einen
`<|channel>thought`-Kanal, den llama.cpp aus `content` herausfiltert. Die Reasoning-Token zählen
gleichwohl als Ausgabe: 11–13k Ausgabe-Token pro Artikel bei rund 4k Zeichen Nutztext.
`maxOutputTokens: 18432` ist damit nicht großzügig, sondern **notwendig**.

---

## 3. Versuchsaufbau

Ein Lauf je Zelle über das echte CLI (`biomd run --only translate --lang de`), also durch die volle
Pipeline: Span-Extraktion, `{hash: text}`-Batch, Reparaturrunde, Struktur-Guard, Splice.

| Einstellung | Wert | Grund |
|---|---|---|
| Pool `translate` | nur `local-small`, `sequential` | sonst schickt `prefer: {de: [or-luna]}` die deutsche Übersetzung an ein *anderes* Modell und der Versuch misst Routing |
| `taskFallback.lastAttempt.temperature` | `0.75` statt `0.1` | **der eine Confound des Vorgänger-Harness**: ein an der Strukturprüfung gescheiterter Task wurde bei `0.1` wiederholt, und die gerettete Übersetzung wurde der Zelle zugeschrieben, die sie nicht erzeugt hat |
| `fallback.maxTargets` | `1` | kein zweites Modell, das die Messung übernimmt |
| `params.seed` | `42` (Pass 1) / `4242` (Pass 2) | innerhalb eines Passes ziehen alle Zellen aus demselben Zufallsstrom — ein Unterschied ist dann dem Sampler zuzuschreiben; zwei Pässe trennen Effekt von Glück |
| `run.concurrency` | `1` | der Server hat einen Slot |
| `output.onExisting` / `run.resume` | `overwrite` / `off` | jede Zelle rechnet wirklich |

`useTranslationMemory: run` blieb wie in Produktion (Cache nur innerhalb eines Laufs, keine
Verschleppung zwischen Zellen). Laufzeit 55–130 s pro Zelle, 1–2 Requests.

**Wie bewertet wurde.** Mechanisch geprüft — und damit der Beurteilung entzogen — wurde nur, wo Lesen
nichts hinzufügt: Skelett-Identität (**36/36 in beiden Pässen `ok`**), unangetastete lateinische
Diskografie (14/14 Zeilen), kyrillische Reste (**0**), Zeichen- und Maskenzahlen, vier Versezeilen,
erhaltener Link. **Alles Semantische ist gelesen**, Zeile gegen Zeile, Quelle gegen Übersetzung, an 14
Diagnosestellen: Kopfzeile, Lead, die drei umgangssprachlichen Blöcke, der musikologische Absatz, das
Zitat von 1821, das Gedicht, vier Diskografie-Zeilen und der ironische Quellenabsatz. Je Kriterium 0–4
Punkte, sieben Qualitäts- und sieben Instruktionskriterien. Matrix und Gold-Erwartungen:
`bakeoff/rubric.md`; Einzelurteile mit Begründung: `bakeoff/scores.py`.

---

## 4. Rangliste — 36 Kombinationen, beste zuerst

`Score = 0.70 × Qualität + 0.30 × Instruktionstreue`, gemittelt über beide Pässe.
`Δ` ist die Abweichung derselben Zelle zwischen Pass 1 und Pass 2 — die **Rauschgrenze** der Zeile.

> **Vor dem Lesen dieser Tabelle:** sie ist das Protokoll der Messung, keine verlässliche Rangfolge. Die
> gepaarte Nachprüfung in Abschnitt 5.4 hat ihre beiden Hauptaussagen widerlegt — vergleiche `Δ` (Median
> 4.2, Maximum 10.7) mit den Abständen zwischen benachbarten Plätzen. Zeilen, die sich um weniger als
> etwa 5 Punkte unterscheiden, sind nicht unterscheidbar.

| # | top_p | top_k | min_p | **Score** | Qualität (70%) | Instruktion (30%) | Pass 1 | Pass 2 | Δ |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **0.915** | **66** | **0.04** | **86.0** | 89.3 | 78.5 | 85.0 | 87.1 | 2.1 |
| **2** | **0.915** | **64** | **0.04** | **86.0** | 89.3 | 78.5 | 85.0 | 87.1 | 2.1 |
| **3** | **0.915** | **62** | **0.04** | **86.0** | 89.3 | 78.5 | 85.0 | 87.1 | 2.1 |
| **4** | **0.915** | **60** | **0.04** | **86.0** | 89.3 | 78.5 | 85.0 | 87.1 | 2.1 |
| 5 | 0.93 | 66 | 0.04 | 84.6 | 85.7 | 82.1 | 87.1 | 82.1 | 5.0 |
| 6 | 0.93 | 64 | 0.04 | 84.6 | 85.7 | 82.1 | 87.1 | 82.1 | 5.0 |
| 7 | 0.93 | 62 | 0.04 | 84.6 | 85.7 | 82.1 | 87.1 | 82.1 | 5.0 |
| 8 | 0.93 | 60 | 0.04 | 84.6 | 85.7 | 82.1 | 87.1 | 82.1 | 5.0 |
| 9 | 0.9 | 66 | 0.05 | 83.9 | 83.9 | 83.9 | 85.7 | 82.1 | 3.6 |
| 10 | 0.93 | 66 | 0.05 | 83.2 | 87.5 | 73.2 | 83.6 | 82.9 | 0.7 |
| 11 | 0.93 | 64 | 0.05 | 83.2 | 87.5 | 73.2 | 83.6 | 82.9 | 0.7 |
| 12 | 0.93 | 62 | 0.05 | 83.2 | 87.5 | 73.2 | 83.6 | 82.9 | 0.7 |
| 13 | 0.93 | 60 | 0.05 | 83.2 | 87.5 | 73.2 | 83.6 | 82.9 | 0.7 |
| 14 | 0.9 | 64 | 0.05 | 82.8 | 83.9 | 80.3 | 83.6 | 82.1 | 1.5 |
| 15 | 0.9 | 62 | 0.05 | 81.9 | 80.3 | 85.7 | 81.8 | 82.1 | 0.3 |
| 16 | 0.9 | 60 | 0.05 | 81.9 | 80.3 | 85.7 | 81.8 | 82.1 | 0.3 |
| 17 | 0.9 | 66 | 0.04 | 81.2 | 83.9 | 75.0 | 80.0 | 82.5 | 2.5 |
| 18 | 0.9 | 66 | 0.06 | 81.1 | 82.2 | 78.6 | 83.6 | 78.6 | 5.0 |
| 19 | 0.9 | 64 | 0.06 | 81.1 | 82.2 | 78.6 | 83.6 | 78.6 | 5.0 |
| 20 | 0.915 | 66 | 0.06 | 81.0 | 82.1 | 78.5 | 80.0 | 82.1 | 2.1 |
| 21 | 0.915 | 64 | 0.06 | 81.0 | 82.1 | 78.5 | 80.0 | 82.1 | 2.1 |
| 22 | 0.915 | 62 | 0.06 | 81.0 | 82.1 | 78.5 | 80.0 | 82.1 | 2.1 |
| 23 | 0.915 | 60 | 0.06 | 81.0 | 82.1 | 78.5 | 80.0 | 82.1 | 2.1 |
| 24 | 0.915 | 66 | 0.05 | 78.5 | 78.6 | 78.5 | 77.5 | 79.6 | 2.1 |
| 25 | 0.93 | 66 | 0.06 | 78.2 | 80.3 | 73.2 | 75.4 | 81.1 | 5.7 |
| 26 | 0.93 | 64 | 0.06 | 78.2 | 80.3 | 73.2 | 75.4 | 81.1 | 5.7 |
| 27 | 0.93 | 62 | 0.06 | 78.2 | 80.3 | 73.2 | 75.4 | 81.1 | 5.7 |
| 28 | 0.93 | 60 | 0.06 | 78.2 | 80.3 | 73.2 | 75.4 | 81.1 | 5.7 |
| 29 | 0.9 | 62 | 0.06 | 78.2 | 80.3 | 73.2 | 83.6 | 72.9 | 10.7 |
| 30 | 0.9 | 60 | 0.06 | 78.2 | 80.3 | 73.2 | 83.6 | 72.9 | 10.7 |
| 31 | 0.9 | 64 | 0.04 | 77.8 | 76.8 | 80.3 | 73.2 | 82.5 | 9.3 |
| 32 | 0.9 | 62 | 0.04 | 77.8 | 76.8 | 80.3 | 73.2 | 82.5 | 9.3 |
| 33 | 0.9 | 60 | 0.04 | 77.8 | 76.8 | 80.3 | 73.2 | 82.5 | 9.3 |
| 34 | 0.915 | 64 | 0.05 | 76.6 | 75.0 | 80.3 | 73.6 | 79.6 | 6.0 |
| 35 | 0.915 | 62 | 0.05 | 76.6 | 75.0 | 80.3 | 73.6 | 79.6 | 6.0 |
| 36 | 0.915 | 60 | 0.05 | 76.6 | 75.0 | 80.3 | 73.6 | 79.6 | 6.0 |

---

## 5. Was jeder der drei Regler tatsächlich tut

### 5.1 `top_k` im Bereich 60–66: wirkungslos

Der auffälligste Befund der ganzen Messung, und er ist rein mechanisch belegbar — nicht durch Bewertung,
sondern durch Byte-Vergleich der Ausgabedateien:

| | verschiedene Ausgaben aus 36 Zellen | `(top_p, min_p)`-Kombinationen, bei denen **alle vier** `top_k`-Werte byte-identisch sind |
|---|---|---|
| Pass 1 (seed 42) | **14** | 5 von 9 |
| Pass 2 (seed 4242) | **11** | **7 von 9** |

Insgesamt also in **16 von 18** Fällen kein einziges anders gezogenes Token. Wo `top_k` doch etwas
änderte, geschah es in den beiden Pässen an *verschiedenen* Stellen (Pass 1 bei `k=66`, Pass 2 an der
Grenze `k64/k62`) — das ist Rauschen, kein Effekt.

Die Erklärung steht in der Sampler-Kette: `top_k` filtert **zuerst**, danach schneiden `top_p 0.9–0.93`
und `min_p 0.04–0.06` die Kandidatenmenge ohnehin weit unter 60 Token. Ob die besten 60 oder die besten
66 in den nachfolgenden Filter gehen, ist für das Ergebnis gleichgültig. `top_k` würde erst dann
wirksam, wenn es *unter* die von `top_p`/`min_p` übrig gelassene Menge fällt — also bei einstelligen bis
niedrig zweistelligen Werten.

**Konsequenz:** die Ranglistenplätze 1–4 (bzw. 5–8, 10–13 …) sind keine vier Ergebnisse, sondern **ein**
Ergebnis, viermal aufgeführt. Ein künftiges Grid sollte `top_k` festhalten und die Läufe in Wiederholungen
investieren.

### 5.2 `min_p`: im 36-Zellen-Grid ein Trend, in der Nachprüfung keiner

Das Grid ergab folgendes Bild — und Abschnitt 5.4 zeigt, dass es nicht trägt:

| `min_p` | Qualität (70 %) | Instruktion (30 %) | Score |
|---|---|---|---|
| 0.04 | 84.5 | 79.9 | 83.1 |
| 0.05 | 81.8 | 79.0 | 81.0 |
| 0.06 | 81.2 | 75.9 | 79.6 |

Gleichgerichtet auf beiden Achsen und in beiden Pässen in derselben Richtung — weshalb dies zunächst als
der belastbarste Befund der Messung galt. Der Haken steckt in der Zählung: wegen der Wirkungslosigkeit
von `top_k` (5.1) standen hinter jeder `min_p`-Stufe nicht 24 unabhängige Läufe, sondern **rund sechs
stark korrelierte Gruppen-Pässe**. Das gepaarte Nachprüf-Experiment mit zwölf Seeds hat den Trend nicht
bestätigt (5.4).

### 5.3 `top_p`: Sprachqualität gegen Regeltreue — ebenfalls nicht belegt

| `top_p` | Qualität (70 %) | Instruktion (30 %) | Score |
|---|---|---|---|
| 0.90 | 80.6 | 79.6 | 80.3 |
| 0.915 | 82.4 | 79.0 | 81.4 |
| 0.93 | 84.5 | 76.2 | 82.0 |

Die beiden Achsen laufen gegeneinander, und die naheliegende Erklärung lautete: Regel 7 verlangt eine
*unwahrscheinliche* Ausgabeform — Name romanisieren, dann eine Glosse in Klammern —, während „einfach
übersetzen" der wahrscheinlichere Pfad ist; ein engerer Nucleus hält das Modell auf dem instruierten Pfad.
Die Geschichte ist plausibel, die Datenlage trägt sie nicht: das Grid sah Regel 7 bei `top_p 0.915` in
**0 von 6** Gruppen-Pässen, die 18 Läufe des Nachprüf-Experiments bei fest `top_p 0.915` aber in
**5 von 18** (28 %). Ein Nullbefund bei sechs Beobachtungen hat unter einer Rate von 28 % eine
Wahrscheinlichkeit von 14 % — also Glück, keine Regel.

Was bleibt, ist die nüchterne Version: **Regel 7 greift bei jeder Einstellung unzuverlässig.** Ob
`top_p 0.90` die Quote messbar hebt, ist mit dieser Datenlage offen; es wäre mit demselben gepaarten
Protokoll zu prüfen, das 5.4 verwendet.

### 5.4 Nachtrag: das gepaarte Nachprüf-Experiment (42 Läufe)

Der Verdacht kam aus dem Grid selbst: bei 4.2 Punkten mittlerem Rauschen und 9.4 Punkten Gesamtspannweite
kann eine Rangfolge aus zwei Pässen wenig tragen. Also derselbe Regler noch einmal, mit einem Protokoll,
das für die Frage gebaut ist:

- **alles außer `min_p` fest** auf der Empfehlung (`temperature 0.75`, `topP 0.915`, `top_k 64`);
- **gepaarte Seeds** — dieselben Seeds in jedem Arm, sodass jeder Vergleich bei identischem Zufallsstrom
  stattfindet und `min_p` der einzige Unterschied ist;
- **zwölf Wiederholungen** je Arm statt zwei;
- gezählt wurden nicht Rubrik-Punkte, sondern **Defekttreffer**: 17 Signaturen bekannter Fehlerklassen
  (kyrillischer Rest, „Marathon der Welt", „MGU KI", „Bis heute", Sinnumkehr in L9, Genusfehler bei
  „zu unserer Schande", Kasuskollision „die Hände sanken", gemischte Anführungszeichen, ersetzter
  Geviertstrich …), gleich angewandt auf jeden Lauf. `bakeoff/defects_minp.py`.

Ergebnis, 12 gepaarte Seeds je Wert:

| `min_p` | Median | Mittel | Median ohne größten Ausreißer |
|---|---|---|---|
| 0.02 | 5.0 | 6.25 | 5.0 |
| 0.04 | 5.5 | 5.42 | 5.0 |
| 0.06 | 5.5 | 6.08 | 5.0 |

| paarweise, gepaart | besser links | besser rechts | gleich |
|---|---|---|---|
| 0.02 vs 0.04 | 5 | 5 | 2 |
| 0.02 vs 0.06 | 4 | 6 | 2 |
| 0.04 vs 0.06 | 3 | 5 | 4 |

**Kein Unterschied.** Die Mediane sind nach Abzug je eines Ausreißers identisch, und die paarweisen
Vergleiche gehen auf; wenn überhaupt liegt `0.06` leicht vorn — das Gegenteil des Grid-Befunds. Die beiden
Sechser-Teilmengen des 0.02-Arms zeigten zudem **entgegengesetzte** Richtungen (Set 1 sprach für 0.04,
Set 2 für 0.02), was Rauschen zuverlässiger kennzeichnet als jede Fehlerbalkenrechnung.

Zwei Nebenbefunde, die dabei abfielen:

- **`min_p` bindet, es nützt nur nichts.** Anders als bei `top_k` war bei **0 von 6** Seeds die Ausgabe
  über die drei `min_p`-Werte byte-identisch — der Filter schneidet also weiterhin Token weg, er
  verschiebt den Text bloß, ohne ihn zu verbessern. Bei Seed 99 waren 0.02 und 0.03 dennoch fast
  derselbe Absatz.
- **Vier Grammatikfehler-Klassen, die im Grid nicht auffielen**, weil ich sie erst beim gepaarten Lesen
  fand: `dass selbst erfahrene Kollegen die Hände sanken` (Kasuskollision — richtig wäre *erfahrenen*
  Kollegen oder „die Hände sinken ließen"), `Er selbst tat auf all die Bewunderung nur ab` (Syntax
  kaputt), `per du` klein statt `per Du`, und Präsenseinbrüche in der Vergangenheitserzählung
  (`Sein Schlag ist einzigartig`). Sie treten in allen Armen auf und sind damit ebenfalls kein
  Sampling-Thema.

---

## 6. Was das Lesen ergab — Übersetzungsqualität

Vorweg das Ergebnis, das für einen Produktionslauf am meisten zählt: **kein einziger der 72 Läufe hat
sinnloses Zeug produziert.** Skelett 36/36 in beiden Pässen identisch, keine kyrillischen Reste, die
lateinische Diskografie 14/14 unangetastet, das Gedicht immer vier Zeilen, der Link immer intakt. Die
Unterschiede liegen sämtlich in der Wortwahl und in der Regeltreue, nicht in der Brauchbarkeit.

### 6.1 Idiomatik — die Stärke des Modells

Der schwierigste Block (Zeile 11) wird durchweg gut getroffen. `с ладами был на «ты»` →
**„war mit den Bünden per Du"**, `строй держался намертво, хоть ты тресни` → **„die Stimmung hielt
bombenfest, koste es, was es wolle"**, `зал заводился с пол-оборота` → **„der Saal war sofort Feuer und
Flamme"** bzw. „kam sofort in Fahrt", `руки опускались` → **„ließen die Hände sinken / resignierten"**,
`рукой махнёт` → **„winkte ab"**, `дело нехитрое` → **„keine große Kunst"**. Ebenso `не все дома` →
**„nicht ganz bei Trost"** und `люди в белых халатах` → **„Leute in weißen Kitteln"**.

Und die kontextkritische Falle ist in **allen 72 Läufen** richtig gelöst: `проигрыш` heißt hier
*Zwischenspiel* (der Instrumentalteil), nicht „Niederlage" — kein Lauf hat sie gestellt.

### 6.2 Wo es kippt

| Stelle | Quelle | richtig | häufiger Fehlgriff |
|---|---|---|---|
| Lead | `Марафон мира` | Friedensmarathon (мир = Frieden) | **„Marathon der Welt"** — inhaltlich falsch; in Pass 2 bei *allen* `top_p 0.9`-Zellen, in Pass 1 bei der Mehrheit |
| Zitat 1821 | `До сего известны были` | „Bis dahin / Bisher" | **„Bis heute"** — sachlich unmöglich, das Zitat ist von 1821; auch „Bis hierher", „Bis jetzt" |
| Zitat 1821 | `передаются к нам за чужестранные` | „werden uns als ausländisch übermittelt" | **„aus dem Ausland übermittelt"** — verliert die Pointe, dass russische Erfindungen *als fremde* zurückkommen |
| Zeile 9 | `не стоит ли обратиться` (rhetorischer Vorschlag) | „man solle sich *vielleicht* wenden" | **„man solle sich *nicht* wenden"** — Sinnumkehr, in Pass 2 bei 8 von 11 Gruppen |
| Zeile 81 | `К стыду ли, или на беду` | „Ob zu unserer Schande oder zu unserem Unglück" | **„zu unserem Schande", „zum Schande"** — Genusfehler |
| Zeile 81 | `дружное 'спасибо'` | „ein gemeinsames ‚Danke'" | **„ein herzliches ‚Danke'"** — dreht die Ironie ins Freundliche |

Einzelne echte Deutschfehler, jeweils nur in einzelnen Zellen: `mit den Bunden`, `der Griffhals`
(Nichtwort), `dass selbst erfahrene Kollegen die Hände sanken` (grammatisch kaputt), `auf «Du-Fuß»`
(erfunden, mit fremden Guillemets), `A propos der Literatur`, `Schumans` (ein n), und in **genau einer**
Zelle (`top_p 0.9 / k66 / min_p 0.05`, Pass 1) ein Namensverfall: **`M. A. Litotschin`** statt
`Litowtschin` — die übrigen 13 Gruppen desselben Passes schreiben ihn korrekt.

### 6.3 Fachsprache und Archaik: unauffällig gut

Der musikologische Absatz gelingt überall: `гомофонно-гармонический склад` → „homophon-harmonischer
Stil/Satz", `подголосочная полифония` → „Unterstimmen-Polyphonie", `соскальзывания` → „Abgleiten",
`соч. 25 № 1` → „Op. 25 Nr. 1". Das Zitat von 1821 hält den gehobenen alten Duktus, `флажиолетные звуки`
→ „Flageolett-Töne", `три лада – 4, 5, 7` → „drei Bünde – 4, 5, 7", `описание оного` → „die Beschreibung
derselben". Abkürzungen ebenfalls: `Зав.кафедры` → „Leiter des Lehrstuhls", `НИИ и ВУЗах` →
„Forschungsinstituten und Hochschulen", `им. М. А. Литовчина` → „benannt nach M. A. Litowtschin" mit
erhaltenen Initialen.

Eine bemerkenswerte Treueprobe hat das Modell überall bestanden: in der Quelle steht mitten im Zitat
plötzlich **`Аксенов`** statt Чудинов (ein Fehler der Quelle selbst). **Kein einziger Lauf** hat ihn
„korrigiert" — alle 72 schreiben Aksenow/Aksenov. Das ist genau das gewünschte Verhalten.

---

## 7. Was das Lesen ergab — Instruktionstreue

Gegen die zehn Regeln aus `prompts/translation/segments-system.md`:

| Regel | Ergebnis |
|---|---|
| 1 kein Zusammenführen/Teilen/Erfinden | ✅ 72/72, Skelett immer identisch |
| 2 Masken `⟦n⟧` zurück | ✅ 72/72, Link in Zeile 86 immer intakt |
| 3 gleiche Zeichen zurückgeben | ⚠️ **die schwächste Regel.** Der Geviertstrich `—` der Quelle wird zum Halbgeviertstrich `–` — in Pass 1 bei 22 von 36 Zellen, in Pass 2 bei **allen 36**; die Anführungszeichen um `"известие"` fallen in den meisten Zellen weg; zwei Zellgruppen fügen 20–26 Anführungszeichen hinzu, die die Quelle nicht hat |
| 4 Fremdsprachiges unangetastet | ✅ 14/14 lateinische Diskografiezeilen wortgleich (Pipeline sendet sie gar nicht — `foreignFragments: keep`), `"Mistral"` überall erhalten |
| 5 Namen rendern, **durchgehend gleich** | ⚠️ in **9 von 25** Gruppen kippt die Schreibung mitten im Text (`Tschudinow` → `Chudinov`) — Pass 1: 4 von 14 Gruppen, Pass 2: 5 von 11; nach Zellen gerechnet 6 bzw. 12 von 36. Wo sie konsistent ist, ist sie es meist als `Tschudinow` (deutsche Umschrift, korrekt) oder `Chudinow` (Mischform: `Ch` ist im Deutschen nicht Ч) |
| 6 gedruckter fremdsprachiger Titel *ist* der Titel | ⚠️ meist erfüllt; ein Fehlgriff ist auffällig: `Впечатление (Ч. Аткинс)` als `„Vpechatlenie" (Eindruck)` — dabei steht dasselbe Stück vierzehn Zeilen höher gedruckt als `Impression (Chet Atkins)` |
| 7 nur quellschriftlicher Titel → Name + Glosse | ⚠️ **der Haupt-Differenzierer**, siehe Abschnitt 1. `top_p 0.9` erfüllt sie reproduzierbar, `0.915` nie |
| 8 zielsprachliche Zeichensetzung | ⚠️ gespalten: manche Zellen setzen durchgängig `„…"`, andere behalten ASCII `"…"`, einige **mischen beides im selben Satz**. Die Kommastellung an den Anführungszeichen war überall korrekt |
| 9 nichts hinzufügen, nichts weglassen | ✅ bis auf eine Zellgruppe, die die Glosse in einer bereits von der Quelle geöffneten Klammer wiederholt (`(Otechestvennye zapiski (Vaterländische Notizen), 1821, …)`) — was Regel 7 ausdrücklich verbietet |
| 10 Vers als Dichtung | ✅ 72/72 vier Zeilen mit Verscharakter und Elision („Ich hör', der Wind hat sich im Laub verfangen") |

Ein Nebenbefund zur Umschrift: mehrere Zellen **mischen zwei Systeme in einem Wort** —
`Otečestwennye zapiski` kombiniert das wissenschaftliche `č` mit dem deutschen `w`. Das ist keine
Sampling-Frage, sondern eine Lücke im Prompt: er sagt „romanisieren", nennt aber kein System.

---

## 8. Defekte, die über alle Einstellungen hinweg gleich bleiben

Wichtig für die Erwartungshaltung: was in allen 114 Läufen gleich falsch ist, lässt sich mit Sampling
nicht reparieren. Nachdem Abschnitt 5.4 die Parametereffekte kassiert hat, ist **dies der Teil des
Berichts mit dem meisten Handlungswert.**

1. **`Семочкин` → „Semotschin"** — das `к` fällt weg, in **allen** 25 Gruppen beider Pässe. Korrekt
   wäre „Semotschkin". Ein Modellfehler.
2. **`—` → `–`** — Pass 1: 22 von 36 Zellen, Pass 2: 36 von 36. Typografisch ist der Halbgeviertstrich im Deutschen sogar der
   üblichere Gedankenstrich, insofern ist der Verstoß gegen Regel 3 hier vertretbar; als Abweichung
   bleibt er messbar.
3. **`МГУКИ` → „MGU KI"** — in der Mehrheit der Zellen, gelegentlich „MGUki". Im Grid hatte es nur
   `top_p 0.93 / min_p 0.05` in beiden Pässen richtig — nach 5.4 ist das als Zufall zu lesen, nicht als
   Einstellungsvorteil: in der Nachprüfung trifft „MGU KI" quer über alle `min_p`-Arme zu.
4. **Gemischte Umschriftsysteme in einem Wort** — `Otečestwennye zapiski` verbindet das
   wissenschaftliche `č` mit dem deutschen `w`, ebenso `Otečestwennyje`. Der Prompt verlangt
   „romanisieren", nennt aber kein System; solange das so ist, wählt das Modell pro Wort neu.
5. **Ein kyrillisch stehengelassener Nachname** — `ЧУДИНОВ` in Zeile 4, zusammen mit englisch statt
   deutsch transliterierten Vornamen (`Aleksei Konstantinovich`). Seedgebunden, nicht
   parametergebunden (Seed 20260824 zeigt es bei `min_p 0.02` *und* `0.06`, elf andere Seeds bei
   keiner Einstellung), also durch keine Konfiguration ausschließbar. Das ist der einzige Fehler der
   Studie, der eine Veröffentlichung unbrauchbar machen würde.

Punkte 1, 3 und 4 gehören in den Prompt. Punkt 5 gehört in die Pipeline: ein Guard, der eine Übersetzung
mit Zeichen der Quellschrift außerhalb der bewusst unangetasteten Fragmente zurückweist, würde ihn
zuverlässig fangen — die Strukturprüfung sieht ihn heute nicht, weil das Skelett intakt bleibt.

---

## 9. Reproduktion

```bash
node bakeoff/gen3.mjs 1          # 36 Configs, seed 42  -> bakeoff/cfg3
node bakeoff/gen3.mjs 2          # 36 Configs, seed 4242 -> bakeoff/cfg4
PROXY_LOG=bakeoff/logs/wire3.jsonl python bakeoff/proxy.py &
bash bakeoff/run_pass.sh 1
bash bakeoff/run_pass.sh 2
```

Auswertung:

```bash
python bakeoff/check3.py 1       # mechanische Tabelle + Byte-Gruppierung je Pass
python bakeoff/cmp3.py 1 11      # eine Zeile aus allen Zellen nebeneinander
python bakeoff/win3.py 1 "Marathon|MGUKI" 40   # Fenster um eine Stelle
python bakeoff/scores.py         # Rangliste + Randmittel je Regler
```

Die gepaarte Nachprüfung aus Abschnitt 5.4:

```bash
node bakeoff/gen_minp.mjs 1      # min_p 0.02/0.03/0.04 x 6 Seeds
node bakeoff/gen_minp.mjs 2      # min_p 0.02/0.04     x 6 frische Seeds
node bakeoff/gen_minp.mjs 3      # min_p 0.06          x denselben 12 Seeds
SET=1 bash bakeoff/run_minp.sh   # analog SET=2, SET=3
python bakeoff/check_minp.py 1   # bindet der Regler noch? (Byte-Vergleich je Seed)
python bakeoff/defects_minp.py 1 # Defekttreffer je Lauf, gepaart je Seed
python bakeoff/cmp_minp.py 11 0 1  # eine Zeile, die min_p-Werte je Seed untereinander
```

| Datei | Inhalt |
|---|---|
| `bakeoff/rubric.md` | Bewertungsmatrix und Gold-Erwartungen je Prüfstelle |
| `bakeoff/scores.py` | die 25 Einzelurteile mit Begründung, plus Aggregation |
| `bakeoff/ranking.json` | die Rangliste als Daten |
| `bakeoff/mech1.json`, `mech2.json` | mechanische Kennzahlen je Zelle |
| `bakeoff/out3/<id>/de/chudinov.bio.md` | die 36 Übersetzungen aus Pass 1 (`out4` für Pass 2) |
| `bakeoff/logs/wire3.jsonl` | jeder Request-Body, wie er den Endpoint erreichte |
| `bakeoff/logs/raw/<id>.p<n>.txt` | vollständige CLI-Ausgabe je Lauf |
| `bakeoff/outM/<id>/de/chudinov.bio.md` | die 42 Übersetzungen der gepaarten Nachprüfung |
| `bakeoff/defectsM_all.json` | Defekttreffer je Lauf der Nachprüfung |

**Für ein nächstes Experiment** — falls überhaupt eines am Sampling nötig ist: nicht rastern, sondern
**paaren**. Zwei Einstellungen, dieselben Seeds, zwölf Wiederholungen, Defektzählung statt Rubrik. Das ist
das Protokoll aus 5.4, es kostete 42 Läufe und hat in einem Nachmittag zwei Befunde des 216-fach größeren
Grids kassiert. Die offene Frage, die es lohnen würde: **`top_p 0.90` gegen `0.915`**, gezählt allein an
der Regel-7-Quote — das ist die einzige Stelle, an der das Grid einen Effekt sah, der groß genug wäre, um
etwas zu bedeuten.

**Der Aufwand gehört aber woanders hin.** Regel 7 greift bei 28 % der Läufe, unabhängig von der
Einstellung; `МГУКИ`, `Semotschin` und die gemischten Umschriftsysteme sind über alle 114 Läufe stabil.
Das sind Prompt-Fragen. Und gegen den einen katastrophalen Ausfall — ein kyrillisch stehengelassener
Nachname, seedgebunden und bei keiner Einstellung ausgeschlossen — hilft kein Sampling, sondern nur ein
Guard: eine Prüfung auf kyrillische Zeichen in der Zielsprache, die die Pipeline noch nicht hat.
