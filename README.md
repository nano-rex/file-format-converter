# File Format Converter

Standalone HTML, CSS, and JavaScript app for local file format conversion. The shipped app has no package manager, build step, CDN calls, web service calls, or runtime third-party dependencies.

## Current browser conversions

- Image: PNG, JPEG, WEBP, BMP/GIF input to PNG/JPEG/WEBP output through Canvas
- Data: CSV to JSON, JSON to CSV
- Text: TXT to HTML, HTML to TXT, TXT to JSON, JSON to TXT

## Engine roadmap

Some requested formats need heavier engines than plain browser APIs can reliably provide. To keep the project standalone, these should be added as vendored local JavaScript/WebAssembly engines or a separately shipped local backend, not as remote CDN or SaaS dependencies.

- PDF to PNG/JPEG/TXT/DOCX/XLSX/PPTX needs a bundled PDF renderer, OCR, table extraction, and layout reconstruction
- XLSX to CSV/JSON and XLS to XLSX need a bundled spreadsheet parser/converter
- DOC to DOCX, DOCX to PDF, and PPT to PPTX need a bundled document/presentation conversion engine
- MP4/WEBM/MKV and audio transcodes need a bundled media encoder

The UI lists these conversions as engine targets so the product surface is ready while the runtime remains dependency-free today.

## Run

Open `index.html` in a browser, or serve the directory with any static file server.
