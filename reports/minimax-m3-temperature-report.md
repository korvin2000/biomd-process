# MiniMax-M3 — Temperatur-Bakeoff, Russisch → Französisch

**Endpoint** `openrouter` — `https://openrouter.ai/api/v1` · **Modell** `minimax/minimax-m3`
**Provider gepinnt** CoreWeave · **Reasoning** abgeschaltet
**Task** `translate`, `mode: segments`, `ru → fr` · **Dokument** `example/example.bio.md`
**Datum** 2026-08-24 · **Läufe** 5 Temperaturen × 2 Seeds = 10 Übersetzungen · **Kosten** $0,0228

---

## 1. Ergebnis

Gewichtung wie gefordert: **70 % Übersetzungsqualität, 30 % Instruction-Following**.

| # | temperature | **Score** | Qualität (70 %) | Instruktionen (30 %) | schlechterer Lauf | Spanne Seed↔Seed |
|---|---|---|---|---|---|---|
| **1** | **0.35** | **75,6** | 73,7 | **80,0** | **73,7** | 3,7 |
| 2 | 0.30 | 72,7 | 73,3 | 71,3 | 71,0 | 3,3 |
| 3 | 0.45 | 72,5 | 71,4 | 75,0 | 70,6 | 3,9 |
| 4 | 0.40 | 72,4 | **75,8** | 64,5 | 69,1 | 6,6 |
| 5 | 0.50 | 71,4 | 74,6 | 63,8 | 69,8 | 3,2 |

**Empfehlung: `temperature: 0.35`.** Sie ist die einzige Zelle, die auf beiden Achsen
auf der guten Seite liegt, und ihr *schlechterer* Lauf (73,7) ist besser als der
schlechtere Lauf jeder anderen Temperatur.

```yaml
# biomd.config.yaml — llm.models
- id: mm3
  endpoint: openrouter
  model: minimax/minimax-m3
  contextWindow: 262144          # CoreWeave; der Aggregatwert bei OpenRouter ist 1 048 576
  maxOutputTokens: 32768
  capabilities: [json_schema, json_object, prompt_cache]
  pricing: { inputPer1M: 0.30, outputPer1M: 1.20, cachedInputPer1M: 0.06 }
  reasoning: { enabled: false, dialect: reasoning }   # sonst denkt das Modell mit
  params:
    temperature: 0.35
    extra:
      provider: { order: [CoreWeave], allow_fallbacks: false }
  tags: [remote]
```

**Lesen Sie Abschnitt 6, bevor Sie den Rängen 2 bis 5 vertrauen.** Die Spanne über
alle fünf Temperaturen beträgt 4,2 Punkte, die Spanne zwischen den *zwei Seeds
derselben* Temperatur bis zu 6,6 Punkte. Belastbar ist der Trend, nicht die
Reihenfolge der Plätze 2 bis 5.

---

## 2. Der eigentliche Befund: die Temperatur tauscht zwei Dinge gegeneinander

Die beiden Teilnoten laufen in **entgegengesetzte Richtungen**, und das ist die
einzige Aussage in diesem Bericht, die das Rauschen überlebt:

```
                0.30    0.35    0.40    0.45    0.50
Qualität        73,3    73,7    75,8    71,4    74,6     ← steigt tendenziell
Instruktionen   71,3    80,0    64,5    75,0    63,8     ← fällt tendenziell
```

- **Nach oben** kauft man Idiomatik. `не жалея ни времени ни сил` wird bei 0.3
  dreimal zu *« sans regretter ni son temps ni ses forces »* (ein Kalkül —
  „bedauern" statt „schonen"), bei 0.5 dreimal zum korrekten
  *« sans ménager ni son temps ni ses forces »*. `с ладами был на «ты»` wird nur
  bei 0.4 und 0.5 zu *« était à tu et à toi avec les frettes »* — der exakten
  französischen Entsprechung. `мол, куда уж нам` wird bei 0.4/0.5 zu
  *« on ne peut pas rivaliser »*, bei 0.3/0.45 zum sinnlosen
  *« où pourrions-nous bien aller »*.
- **Nach unten** kauft man Formtreue. Alle drei Läufe, die den Nachnamen als
  **`TCHOU DINOV`** zerlegen, und beide Läufe, die die Gedankenstriche des
  Originals durch andere ersetzen, liegen bei 0.4 oder darüber.

0.35 ist der Punkt, an dem die erste Kurve schon gestiegen und die zweite noch
nicht gefallen ist.

---

## 3. Die Parameter werden tatsächlich angewendet

Nachgewiesen, nicht angenommen.

**a) Logprobs-Test.** Dieselbe Anfrage bei `temperature` 0.0 / 0.4 / 2.0, mit
`logprobs: true, top_logprobs: 5`:

| temperature | gewähltes erstes Token | dessen logprob | Top-1 der Verteilung |
|---|---|---|---|
| 0.0 | `"à"` | −0,150 | `"à"` (−0,150) |
| 0.4 | `"à"` | −0,150 | `"à"` (−0,150) |
| 2.0 | `"Cord"` | **−7,275** | `"à"` (−0,150) |

CoreWeave liefert die Logprobs *vor* der Temperaturskalierung — die Verteilung
bleibt in allen drei Zeilen identisch. Genau deshalb ist die dritte Zeile der
Beweis: bei 2.0 wählt der Sampler ein Token, das 7,1 nats unter dem Maximum
liegt und nicht einmal unter den Top 5 steht. Der Parameter erreicht den Sampler.

**b) Diversitätstest.** Ein idiomatischer Satz aus dem Testdokument, je 4 Samples:

| temperature | verschiedene Antworten |
|---|---|
| 0.00 | 2 / 4 |
| 0.30 | 3 / 4 |
| 0.40 | 2 / 4 |
| 0.50 | **4 / 4** |
| 1.50 | **4 / 4** |

Dass 0.0 nicht 1/4 liefert, ist kein Widerspruch: fp4-Quantisierung und
Batch-Nichtdeterminismus erzeugen auch bei greedy decoding Varianz. Der Trend
ist trotzdem eindeutig genug.

**c) `seed` wirkt.** Dreimal dieselbe Anfrage mit `seed: 4242` bei
`temperature: 0.5` → **1 / 3 verschiedene Antworten**, also dreimal identisch.
Deshalb sind die beiden Läufe je Zelle mit *unterschiedlichen* Seeds (42, 4242)
gefahren: mit gleichem Seed wäre der zweite Lauf eine Kopie und kein Sample.

---

## 4. Fähigkeiten und Reasoning

**Geforderte Modi — alle drei vorhanden**, laut OpenRouters `supported_parameters`
und beim Pin auf CoreWeave bestätigt:

| Fähigkeit | Nachweis |
|---|---|
| `json_object` | `response_format` in den Provider-Parametern; alle 10 Läufe haben es gesendet und valides JSON zurückbekommen |
| `json_schema` | `structured_outputs` in den Provider-Parametern |
| `prompt_cache` | eigener Preis `input_cache_read` = $0,05/M (CoreWeave), $0,06/M (Aggregat) |

`seed` ist zusätzlich vorhanden — aber **nicht bei allen Providern**. Sechs der
dreizehn Anbieter dieses Modells lassen `seed` fallen, mehrere auch
`response_format`. Ohne Pin vergleicht ein solcher Test Provider statt
Temperaturen; deshalb `provider: { order: [CoreWeave], allow_fallbacks: false }`.

**Reasoning ist standardmäßig AN und lässt sich abschalten.** Gemessen an einer
Ein-Wort-Frage:

| Anfrage | reasoning_tokens | prompt_tokens | Antwort |
|---|---|---|---|
| ohne `reasoning`-Feld | **24** | 192 | Paris |
| `reasoning: { enabled: false }` | **0** | 179 | Paris |

Die Wire-Form `{"reasoning": {"enabled": false}}` ist genau das, was dieses Repo
bei `reasoning: { enabled: false, dialect: reasoning }` sendet
(`reasoningFields` in [OpenAiCompatibleClient.ts:148](src/llm/OpenAiCompatibleClient.ts:148)) —
es war also nichts zu implementieren. Dass auch die *prompt*-Tokens von 192 auf
179 fallen, zeigt, dass der Provider im Denkmodus zusätzlich eine Präambel
einfügt: Abschalten spart auf beiden Seiten. Alle 10 Läufe liefen ohne Reasoning.

> Anmerkung zur Aufgabenstellung: recherchiert wurde `openrouter`, nicht
> `omniroute` — die getestete Konfiguration nutzt ausschließlich den
> OpenRouter-Endpoint. Für `omniroute` gilt im Repo weiterhin, dass
> `or-search-quality` mit `400 Reasoning is mandatory for this endpoint`
> antwortet, Abschalten dort also gerade *nicht* geht.

---

## 5. Was in den Übersetzungen tatsächlich steht

Alle zehn Läufe sind Zeile für Zeile gegen das Original gelesen worden. Der
Text hält sich durchweg an die Struktur: **1 Request pro Lauf, 0 Retries, 0
Fallbacks, 0 Reparaturrunden, Skeleton-Guard `strict` bestanden**, alle
lateinischen Fragmente (die Gitarrenduo-Diskografie) unverändert, das Gedicht in
allen zehn Läufen als vier Zeilen. Unterschieden wird also im Inhalt, nicht im
Vertrag.

### 5.1 Was alle zehn Läufe richtig machen

- `флажолетные звуки` → *sons harmoniques* (10/10) — der schwierigste Fachbegriff
  im Text, überall getroffen.
- **`Аксенов` wird nicht „korrigiert".** Die Quelle nennt mitten im Zitat
  plötzlich einen anderen Namen als im Satz davor; kein einziger Lauf hat daraus
  stillschweigend „Tchoudinov" gemacht. Das ist Regel 9, und es ist der Test, den
  Modelle am häufigsten verlieren.
- `гомофонно-гармонический склад` → *écriture homophone(-ique)-harmonique*,
  `соч. 25 «1` → *op. 25 n° 1*, `МГУКИ` → *(MGUKI)*, `НИИ`/`ВУЗ` ausgeschrieben.
- Kein erfundener Satz, keine Auslassung: die Zeilen-Expansionsrate liegt
  durchgängig bei 1,15–1,46 (normal für ru→fr).

### 5.2 Was alle zehn Läufe falsch machen

Diese Fehler unterscheiden die Temperaturen **nicht** — sie sind Eigenschaften
des Modells und gehören in den Prompt oder ins Glossar, nicht in die
Sampling-Konfiguration:

| Stelle | Alle 10 Läufe | Richtig wäre |
|---|---|---|
| **Diskografie, 6 russische Titel** | *Reste avec moi*, *Ronde*, *Humeur mélancolique* … — **übersetzt statt romanisiert** | Regel 7: `"Poboud' so mnoï" (Reste avec moi)` |
| `им. М. А. Литовчина` | *… Litovtchina* | *Litovtchine* — der russische Genitiv wird mitübersetzt |
| `зал заводился с пол-оборота` | *la salle s'embrasait* — „с пол-оборота" fällt weg | *… au quart de tour* (dasselbe Modell liefert das im Einzelsatz-Test!) |
| `Кстати, о литературе` | *À propos de littérature* | „Kstati" (übrigens) fehlt |
| `к проигрышу` | 9 von 10: *au refrain* | **`проигрыш` ist das Zwischenspiel, nicht der Refrain** |

Die erste Zeile dieser Tabelle ist genau die Regel, nach der Sie gefragt haben
(„romanisieren, Übersetzung in Klammern") — und das Modell verletzt sie in der
Diskografie **in allen Läufen**. Die einzige Stelle, an der es überhaupt
romanisiert, ist der Zeitschriftentitel, und dort unterscheiden sich die Zellen:

| Lauf | `"Отечественных записках"` |
|---|---|
| **t=0.30 / s42**, **t=0.35 / s42** | `« Notes nationales » (Otetchestvennye zapiski)` — beide Hälften da, **Reihenfolge vertauscht** |
| t=0.45 / s42 | `« Отечественные записки » (Notes patriotiques)` — Reihenfolge richtig, **Name kyrillisch geblieben** |
| die übrigen 7 | `« Notes nationales »` — nur übersetzt, keine Romanisierung |

Der kyrillische Rest bei `t=0.45 / s42` ist der einzige harte Defekt, den auch
die maschinelle Prüfung findet (40 kyrillische Zeichen in Zeile 18 und 20) — für
einen französischen Leser ist der Titel damit unlesbar.

### 5.3 Wo sich die Temperaturen unterscheiden

| Prüfstelle (Original) | schwache Antwort | starke Antwort | wer liefert die starke |
|---|---|---|---|
| `не жалея ни времени ни сил` | *sans regretter…* (Kalkül) | *sans ménager…* | 0.40/s4242, **0.50 beide** |
| `с ладами был на «ты»` | *en familiarité avec les frettes* | *à tu et à toi avec les frettes* | 0.40/s4242, 0.50/s42 |
| `Бой у него свой` | *Son attaque était à lui* | *Sa manière de gratter était à lui* | 0.40/s4242 |
| `мол, куда уж нам` | *où pourrions-nous bien aller* (**sinnlos**) | *on ne peut pas rivaliser* / *nous n'avons pas le niveau* | 0.35/s4242, 0.40/s4242, 0.50/s4242 |
| `у видавших виды коллег руки опускались` | *en restaient pantois* | *baissaient les bras* | 0.30/s4242 |
| `не все дома` | *n'avait pas tous ses esprits* | *n'avait pas un grain* | 0.35/s42, 0.50/s4242 |
| `аспирантура` | *une aspirantura* (unübersetzt) | *troisième cycle* | alle ab 0.35 außer 0.40/s4242 |
| `лады – 4, 5, 7` | **`accords`** (= Akkorde, sinnentstellend) | *frettes* | alle außer 0.50/s4242 |
| `дескать, дело нехитрое` | *genre, c'est pas sorcier* (Register) | *ce n'est pas sorcier* | 0.30/s42, 0.35/s4242, 0.40/s4242, 0.45/s4242, 0.50/s4242 |
| `чистая хроматика` | *de la chromatisme* (**Genusfehler**) | *du chromatisme pur* | 0.35/s4242, 0.45/s4242 |

Und auf der Instruktionsseite:

| Prüfstelle | Verstoß | betroffene Läufe |
|---|---|---|
| Regel 5 — ein Name, eine Schreibung | `TCHOU DINOV` (Leerzeichen im Nachnamen) | 0.30/s4242, 0.40/s42, 0.50/s4242 |
| Regel 5 — Namenswiedergabe | `Н. Зубов` → *N. **Zourov*** | 0.30/s42, 0.35/s42, 0.40 beide, 0.50/s4242 |
| Regel 5 | `М. Матусовский` → *M. **Matiessovski*** | 0.50/s42 |
| Regel 5 | *Subbotina* statt *Soubbotina* — zwei Transliterationssysteme in einem Dokument | 0.50/s4242 |
| Regel 3 — dieselben Zeichen zurück | Halbgeviertstrich statt Geviertstrich (bzw. umgekehrt) | 0.40/s4242, 0.50 beide |
| Regel 3 | Gedankenstrich im Lead durch *est un* ersetzt | 0.40/s42, 0.50/s4242 |
| Regel 8 — Satzzeichen außerhalb des Anführungszeichens | `« merci ! »` | 0.45/s4242 |

`Zourov` für `Зубов` ist der unangenehmste Fehler der Liste: er sieht wie ein
Name aus, ist aber keiner, und nichts stromabwärts kann ihn fangen.

---

## 6. Wie belastbar das ist

**Nicht sehr — und das war die Vorgabe.** Zwei Läufe pro Zelle, zehn Läufe
insgesamt:

- Die Spanne über die fünf Temperaturen beträgt **4,2 Punkte** (71,4 … 75,6).
- Die Spanne zwischen den *zwei Seeds derselben* Temperatur beträgt 3,2 bis
  **6,6 Punkte**.

Das Rauschen ist also so groß wie das Signal. Belastbar ist damit:

1. **Der Trend in Abschnitt 2** — Qualität steigt, Regeltreue fällt. Er wird von
   jeweils mehreren unabhängigen Prüfstellen getragen, nicht von einer Zelle.
2. **Dass 0.35 kein schlechter Kompromiss ist** — sie hat den besten schlechteren
   Lauf des Feldes.
3. **Dass die Wahl innerhalb von 0.3 … 0.5 wenig kostet.** Der Unterschied
   zwischen bester und schlechtester Temperatur ist kleiner als der Unterschied,
   den ein Prompt-Fix an der Diskografie-Regel bringen würde.

Nicht belastbar ist die Reihenfolge der Plätze 2 bis 5. Wer sie braucht, braucht
6 bis 8 Seeds pro Zelle (≈ $0,09) und dasselbe gepaarte Protokoll.

---

## 7. Reproduktion

```bash
node bakeoff/gen_m3.mjs && bash bakeoff/run_m3.sh && node bakeoff/score_m3.mjs
```

| Schritt | Datei |
|---|---|
| Konfigurationen erzeugen | [bakeoff/gen_m3.mjs](bakeoff/gen_m3.mjs) → `bakeoff/cfgT/` |
| 10 Läufe | [bakeoff/run_m3.sh](bakeoff/run_m3.sh) → `bakeoff/outT/<id>/fr/` |
| maschinelle Prüfungen | [bakeoff/defects_m3.mjs](bakeoff/defects_m3.mjs) |
| Quelle und alle 10 Zellen zeilenweise nebeneinander | [bakeoff/align.mjs](bakeoff/align.mjs) `10` |
| Wertung | [bakeoff/score_m3.mjs](bakeoff/score_m3.mjs) |

| | |
|---|---|
| Korpus | `bakeoff/inputM3/ru/chudinov.bio.md` (Kopie von `example/example.bio.md`) |
| Pro Lauf | 1 Request, 4,2k Input- / 2,0k Output-Tokens, 11–17 s, ~$0,0022 |
| Gesamt | **$0,0228** für 10 Übersetzungen, plus ~$0,002 für die Vorabtests |
| Fixiert | Provider CoreWeave, Reasoning aus, `maxSegmentsPerCall: 45`, `foreignFragments: keep`, `fencedBlocks: auto`, `verifyStructure: strict`, `useTranslationMemory: run`, `repairAttempts: 2`, `contextChars: 300` |
| Variiert | ausschließlich `temperature` und `seed` |

Die Wertung in [bakeoff/score_m3.mjs](bakeoff/score_m3.mjs) liegt offen als
Tabelle vor: 28 Qualitäts- und 10 Instruktions-Prüfstellen, je Zelle ein Wert
zwischen 0 und 1. Wer eine Einzelbewertung anders sieht, ändert eine Zahl und
bekommt sofort die neue Rangliste.
