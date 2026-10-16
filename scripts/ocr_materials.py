#!/usr/bin/env python3
"""Local RapidOCR helper for original raster files and every page of a PDF."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import json
import os
import sys
from pathlib import Path
from typing import Any


def recognized_text(result: Any) -> str:
    if result is None:
        raise RuntimeError("missing_rapidocr_result")
    values = getattr(result, "txts", None)
    if values is None:
        return ""
    return "\n".join(str(value).strip() for value in values if value and str(value).strip())


def run_image(engine: Any, path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError("input_not_found")
    return {"kind": "image", "pages": [{"page": 1, "text": recognized_text(engine(str(path)))}]}


def run_pdf(engine: Any, path: Path) -> dict[str, Any]:
    import pypdfium2 as pdfium

    if not path.is_file():
        raise FileNotFoundError("input_not_found")
    document = pdfium.PdfDocument(path)
    try:
        pages = []
        for index in range(len(document)):
            page = document[index]
            try:
                image = page.render(scale=2.5).to_numpy()
                pages.append({"page": index + 1, "text": recognized_text(engine(image))})
            finally:
                page.close()
    finally:
        document.close()
    return {"kind": "pdf", "pages": pages}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("image", "pdf"))
    parser.add_argument("file", type=Path)
    parser.add_argument("--all-pages", action="store_true")
    args = parser.parse_args()

    if args.kind == "pdf" and not args.all_pages:
        parser.error("PDF OCR requires --all-pages")
    if args.kind == "image" and args.all_pages:
        parser.error("--all-pages is valid only for PDF")

    try:
        with redirect_stdout(sys.stderr):
            from rapidocr import RapidOCR

            model_root = Path(os.environ["STUDIO_RAPIDOCR_MODEL_DIR"]) if os.environ.get("STUDIO_RAPIDOCR_MODEL_DIR") else Path(__file__).resolve().parent.parent / ".studio-runtime" / "rapidocr-models"
            engine = RapidOCR(params={"Global.model_root_dir": str(model_root)})
            result = run_image(engine, args.file) if args.kind == "image" else run_pdf(engine, args.file)
        sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except Exception:
        # Keep local paths, model download URLs, and library diagnostics out of caller output.
        sys.stderr.write("OCR processing failed\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
