# File Format Converter

Local file format converter with a browser frontend and a Bun server. The app has no npm package dependencies, no CDN calls, no remote conversion service calls, and no external converter program calls.

## Current conversions

- Browser-native: PNG/JPEG/WEBP/BMP/GIF image input to PNG/JPEG/WEBP output, CSV to JSON, JSON to CSV, TXT to HTML, HTML to TXT, TXT to JSON, JSON to TXT
- Built-in OpenXML: CSV to XLSX, XLSX to CSV/JSON, TXT to DOCX, DOCX to TXT
- Built-in PDF: TXT to PDF, DOCX to PDF, and best-effort PDF text extraction to TXT/DOCX/XLSX/PPTX for simple PDFs

## Runtime requirements

Install Bun on the host running the app:

- Bun

The JavaScript project itself has no third-party package dependencies and does not invoke Poppler, LibreOffice, FFmpeg, or other external converter binaries.

The built-in converters are intentionally limited. They handle straightforward text PDFs, text documents, and first-sheet spreadsheet data without preserving advanced formulas, charts, styles, comments, tracked changes, media codecs, images, scanned PDF OCR, or complex layout.

See [Native Converter Design](docs/native-converters.md) for the implementation approach and current limits.

## Run

```sh
bun run start
```

Then open `http://localhost:3000`.

## License

GPL-3.0-or-later. This keeps the project compatible with future GPL-covered converter code.
