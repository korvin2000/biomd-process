#!/usr/bin/env python3
"""bio-stats - Klammer- und Groessenstatistik fuer lokalisierte *.bio.md Dateien.

Scannt {input-dir}/{iso2}/*.bio.md, gruppiert die Dateien ueber alle Sprachen
hinweg nach ihrem Basisnamen und schreibt einen Markdown-Report ('report.md').
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

BIO_SUFFIX = ".bio.md"
DEFAULT_EXCLUDED = "ru"

# Ein Sprachverzeichnis besteht aus genau zwei Buchstaben (ISO 639-1).
LANG_DIR_RE = re.compile(r"^[A-Za-z]{2}$")

# Absatztrenner: eine Leerzeile (optional mit Whitespace), CRLF-tolerant.
PARAGRAPH_SPLIT_RE = re.compile(r"\r?\n[ \t]*\r?\n")


# --------------------------------------------------------------------------
# Zaehl-Logik
# --------------------------------------------------------------------------

def count_bracket_pairs(text: str) -> int:
    """Zaehlt vollstaendige runde Klammerpaare.

    Ein Paar zaehlt nur, wenn die oeffnende und die schliessende Klammer im
    selben Textblock/Absatz liegen. Unbalancierte Klammern - etwa Aufzaehlungen
    wie "1)" oder Smileys - werden dadurch verworfen.
    """
    total = 0
    for block in PARAGRAPH_SPLIT_RE.split(text):
        open_count = 0
        for ch in block:
            if ch == "(":
                open_count += 1
            elif ch == ")" and open_count > 0:
                open_count -= 1
                total += 1
    return total


# --------------------------------------------------------------------------
# Einlesen
# --------------------------------------------------------------------------

def discover_languages(input_dir: Path, excluded: set[str]) -> tuple[list[str], list[str]]:
    """Liefert (Sprachcodes, ignorierte Verzeichnisnamen)."""
    langs: list[str] = []
    ignored: list[str] = []
    for entry in sorted(os.scandir(input_dir), key=lambda e: e.name.lower()):
        if not entry.is_dir():
            continue
        name = entry.name
        if not LANG_DIR_RE.match(name):
            ignored.append(name)
            continue
        if name.lower() in excluded:
            continue
        langs.append(name.lower())
    return langs, ignored


def collect_stats(input_dir: Path, langs: list[str]):
    """Sammelt pro Basisname und Sprache: Klammerpaare und Dateigroesse in Bytes."""
    counts: dict[str, dict[str, int]] = {}
    sizes: dict[str, dict[str, int]] = {}
    for lang in langs:
        for path in sorted((input_dir / lang).glob("*" + BIO_SUFFIX)):
            if not path.is_file():
                continue
            base = path.name[: -len(BIO_SUFFIX)]
            text = path.read_text(encoding="utf-8", errors="replace")
            counts.setdefault(base, {})[lang] = count_bracket_pairs(text)
            sizes.setdefault(base, {})[lang] = path.stat().st_size
    return counts, sizes


# --------------------------------------------------------------------------
# Markdown-Ausgabe
# --------------------------------------------------------------------------

def md_table(header: list[str], rows: list[list[str]]) -> str:
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return "\n".join(lines)


def fmt_pct(value: float) -> str:
    """Prozentwert mit hoechstens einer Nachkommastelle ("50%", "66.7%")."""
    text = f"{value:.1f}"
    if text.endswith(".0"):
        text = text[:-2]
    return text + "%"


def raw_table(langs: list[str], data: dict[str, dict[str, int]]) -> str:
    rows = []
    for base in sorted(data):
        per_lang = data[base]
        rows.append([base] + [str(per_lang[l]) if l in per_lang else "-" for l in langs])
    return md_table(["name", *langs], rows)


def bracket_diff_table(langs: list[str], counts: dict[str, dict[str, int]]) -> str:
    """Differenz zum Maximum pro Datei, letzte Spalte = Maximalwert."""
    rows = []
    for base in sorted(counts):
        per_lang = counts[base]
        maximum = max(per_lang.values())
        cells = [base]
        cells += [str(maximum - per_lang[l]) if l in per_lang else "-" for l in langs]
        cells.append(str(maximum))
        rows.append(cells)
    return md_table(["name", *langs, "max"], rows)


def size_diff_table(langs: list[str], sizes: dict[str, dict[str, int]]) -> str:
    """Prozentuale Abweichung der Dateigroesse zur groessten Sprachvariante."""
    rows = []
    for base in sorted(sizes):
        per_lang = sizes[base]
        maximum = max(per_lang.values())
        cells = [base]
        for lang in langs:
            if lang not in per_lang:
                cells.append("-")
            elif maximum == 0:
                cells.append("0%")
            else:
                cells.append(fmt_pct((maximum - per_lang[lang]) / maximum * 100))
        rows.append(cells)
    return md_table(["name", *langs], rows)


def build_report(input_dir: Path, langs: list[str], counts, sizes, include_raw: bool) -> str:
    parts = [
        "# bio.md localization report",
        "",
        f"- source: `{input_dir}`",
        f"- languages: {', '.join(langs)}",
        f"- files: {len(counts)}",
        "",
    ]
    if include_raw:
        parts += ["## Round bracket pairs (raw)", "", raw_table(langs, counts), ""]
    parts += [
        "## Round bracket pairs - difference to maximum",
        "",
        "Value = maximum for this file minus the actual count "
        "(`0` = highest count, `-` = language missing).",
        "",
        bracket_diff_table(langs, counts),
        "",
    ]
    if include_raw:
        parts += ["## File sizes in bytes (raw)", "", raw_table(langs, sizes), ""]
    parts += [
        "## File size - difference to maximum",
        "",
        "Value = how much smaller the file is compared to the largest "
        "language variant (`0%` = largest, `-` = language missing).",
        "",
        size_diff_table(langs, sizes),
        "",
    ]
    return "\n".join(parts)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bio-stats",
        description="Compare localized *.bio.md files: round bracket pairs and file sizes.",
    )
    parser.add_argument("input_dir", help="directory containing {iso2}/ subdirectories")
    parser.add_argument("-o", "--output", default="report.md",
                        help="output markdown file (default: report.md)")
    parser.add_argument("--exclude", default=DEFAULT_EXCLUDED,
                        help="comma separated language codes to skip (default: %(default)s)")
    parser.add_argument("--raw", action="store_true",
                        help="also include the raw count / size tables in the report")
    args = parser.parse_args(argv)

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        print(f"error: not a directory: {input_dir}", file=sys.stderr)
        return 2

    excluded = {c.strip().lower() for c in args.exclude.split(",") if c.strip()}
    langs, ignored = discover_languages(input_dir, excluded)
    if not langs:
        print(f"error: no language directories found in {input_dir}", file=sys.stderr)
        return 1
    for name in ignored:
        print(f"note: skipping '{name}' (not a 2-letter language code)", file=sys.stderr)

    counts, sizes = collect_stats(input_dir, langs)
    if not counts:
        print(f"error: no *{BIO_SUFFIX} files found in {input_dir}", file=sys.stderr)
        return 1

    report = build_report(input_dir, langs, counts, sizes, args.raw)
    output = Path(args.output)
    output.write_text(report, encoding="utf-8")

    print(f"languages : {', '.join(langs)}")
    print(f"files     : {len(counts)}")
    print(f"report    : {output.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
