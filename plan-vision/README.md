# plan-vision

Optional OCR and classical computer-vision service for reading a PDF or scanned plan sheet when no
Civil 3D drawing exists. It is a separate Python 3 process. The MCP server calls it through
`src/utils/PlanVisionBridge.ts` once per command, with JSON on stdin and one JSON object on stdout.

This service is **optional**. `civil3d_plan_vision` is the only domain that never opens a plugin
connection, and the MCP server starts and every other tool works without Python, Tesseract or any
package in this folder.

## What is not needed

- No Civil 3D drawing and no running plugin.
- No Python at all, unless you call `civil3d_plan_vision` with a raster or OCR action.

## System prerequisites

These are not pip packages. `pip install -r requirements.txt` alone is not sufficient.

1. Python 3.10 or later on the PATH.
2. Tesseract OCR, installed separately and on the PATH, or named by the environment variable
   `TESSERACT_CMD`. Confirm with `tesseract --version`.

PyMuPDF rasterizes PDF pages with one pip install, so the Poppler binary that `pdf2image` needs is
not required.

## Setup

```bash
cd plan-vision
python -m venv .venv
.venv/Scripts/activate      # Windows
.venv/bin/activate          # Linux
pip install -r requirements.txt
tesseract --version
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLAN_VISION_PYTHON` | `python3` on Linux and macOS, `python` on Windows | Path to the interpreter. Point it at the venv, for example `plan-vision/.venv/Scripts/python.exe`. |
| `PLAN_VISION_TIMEOUT` | `120000` | Per-call timeout in milliseconds. |
| `TESSERACT_CMD` | unset | Optional explicit path to the Tesseract binary. |

## Behaviour when the service is not configured

Before the first call, the bridge runs one cheap preflight against the interpreter: the version must
be 3.10 or later and every pip package in `requirements.txt` must import. When the interpreter is
missing, is too old, or a package is absent, the call fails with one explicit message that names the
interpreter, the reason, and the fix. The bridge never retries the preflight after a result, and it
never falls back to another interpreter, because a silent fallback would hide a broken install.

The two messages are:

- `plan-vision service is not configured: <reason>. Install Python 3.10 or later and the pinned
  packages with 'pip install -r <requirements file>', or set PLAN_VISION_PYTHON to the
  interpreter's full path. <n> of 6 actions need this service; calibrate_scale_from_dimension does
  not.`
- `plan-vision service is not configured: Tesseract OCR was not found ...`

## CLI contract

`cli.py` takes exactly one command as its first argument and the JSON arguments on stdin. It prints
one JSON object on stdout and exits 0, or prints one error line on stderr and exits non-zero. It
never prints a Python traceback.

```bash
echo '{"pdfPath": "sheet.pdf", "page": 0, "dpi": 300}' | python cli.py rasterize_pdf_page
```

Commands: `rasterize_pdf_page`, `extract_legend_templates`, `train_symbol_template`,
`detect_symbols_cv`, `ocr_extract_labels`. The sixth action,
`calibrate_scale_from_dimension`, is pure TypeScript arithmetic and never starts this process.

## Confidence, not exactness

Everything this service returns is a probabilistic detection over pixels. It depends on scan
quality and the confidence threshold. It is not the exactness that `civil3d_blocks` gives for real
blocks in a drawing.

`detect_symbols_cv` defends against two known false-positive sources. A template with no internal
contrast is mathematically degenerate for normalized correlation, so it is reported in
`skippedTemplates` with a reason instead of producing false full-confidence matches. A candidate
whose ink ratio differs too much from its template is discarded. Crop symbols with their visible
edge.

## Verification limit

On this Linux host and on the Windows build host the Python path cannot run. Tesseract is not
installed and the pinned packages are absent. The port therefore proves only that the TypeScript
compiles and that the bridge degrades to the message above. It does not prove that a raster or OCR
call succeeds against a real sheet. That check belongs to the operator, on a machine with the
service installed.
