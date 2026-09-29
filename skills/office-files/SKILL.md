---
name: office-files
description: Read Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and PDF files as Markdown, write Word documents from Markdown, turn CSV/JSON into a formatted spreadsheet, merge or split PDFs, and render pages to PNG to check how they look. Use for quick office-file work; for full slide decks use sn-ppt-entry, for Excel analysis sn-da-excel-workflow, for analysing Word/PDF/PPT content sn-da-non-spreadsheet-analysis.
---

# Office files (RedPi)

One helper script, `office.py` in this skill's folder, run through `uv` so its open-source libraries (python-docx, openpyxl, python-pptx, pypdf) never touch the system Python. Call it by absolute path; below, `$OFFICE` is `<this skill's folder>/office.py` and `$RUN` is:

```bash
uv run --quiet --with python-docx --with openpyxl --with python-pptx --with pypdf python
```

No `uv`? Use a throwaway venv: `python3 -m venv /tmp/office-venv && /tmp/office-venv/bin/pip install -q python-docx openpyxl python-pptx pypdf`, then run `/tmp/office-venv/bin/python $OFFICE ...`.

## Which skill

| Task | Use |
| --- | --- |
| A real slide deck (research, outline, designed pages, PPTX) | `sn-ppt-entry` (SenseNova) |
| Analyse or clean Excel data, large sheets | `sn-da-excel-workflow`, `sn-da-large-file-analysis` |
| Analyse the content of Word / PDF / PPT files | `sn-da-non-spreadsheet-analysis` |
| Markdown report to a designed HTML page | `sn-md-to-html-report` |
| Everything quick: read a file, write a .docx, CSV to .xlsx, merge/split PDFs, look at pages | this skill |

## Commands

| Goal | Command |
| --- | --- |
| Read any of them as Markdown | `$RUN $OFFICE read file.docx` (also .xlsx, .pptx, .pdf; `--max 200000` for long files) |
| Markdown to Word | `$RUN $OFFICE docx notes.md out.docx` |
| Markdown outline to a plain PowerPoint | `$RUN $OFFICE pptx outline.md out.pptx` |
| CSV or JSON rows to Excel | `$RUN $OFFICE xlsx data.csv out.xlsx --sheet Sales` |
| Merge PDFs | `$RUN $OFFICE merge out.pdf a.pdf b.pdf` |
| Pick pages | `$RUN $OFFICE pages in.pdf 1-3,7 out.pdf` |
| Render pages to PNG | `$RUN $OFFICE render file.pdf shots/ --pages 1-2` |
| Office file to PDF | `$RUN $OFFICE topdf file.docx outdir/` (needs LibreOffice) |
| Recalculate spreadsheet formulas | `$RUN $OFFICE recalc book.xlsx` (needs LibreOffice) |

Markdown supported when writing: `#` headings, paragraphs, `-` / `1.` lists (indent two spaces per level), tables, fenced code, `**bold**`, `*italic*`, `` `code` ``. In `pptx`, a first `# Title` makes the cover, every `##` starts a slide, and a paragraph starting `Notes:` becomes speaker notes. `---` is a page break in Word and a new slide in PowerPoint.

## Working rules

- **Read before you edit.** Run `read` first so you know the structure (styles, sheets, slide titles) you are changing.
- **Editing an existing file**: open it with the library in a short Python script (`$RUN - <<'PY' ... PY`) and change only what was asked. Keep its styles, headers, formulas and layout; never rebuild a user's document from Markdown, since that throws away formatting.
- **Spreadsheets**: write formulas (`=SUM(B2:B9)`) rather than values you computed, so the sheet stays live. openpyxl does not calculate: `read` shows a formula's cached value only after Excel or LibreOffice has saved the file; say so, or run `recalc` when LibreOffice is installed.
- **Look at the result** when layout matters: `render` it and read the PNGs (Word and PowerPoint need LibreOffice for that; without it, `read` the file back and check the structure instead).
- Write new files next to the input or where the user asked, never over the original unless asked.
- Scanned PDFs have no text: `render` the pages and read the images.
