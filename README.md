# File Format Converter

Local file format converter with a browser frontend and a Bun server. The app has no npm package dependencies, no CDN calls, no remote conversion service calls, and no external converter program calls.

## Current conversions

| Input | Output |
| --- | --- |
| PDF | TXT, HTML, DOCX, XLSX, PPTX, CSV |
| DOCX | TXT, HTML, PDF, PPTX |
| XLSX | CSV, JSON, TXT, HTML, PDF, DOCX |
| PPTX | TXT, HTML, PDF, DOCX |
| TXT | DOCX, PDF, PPTX, HTML, JSON |
| CSV | XLSX, PDF, DOCX, HTML, JSON |
| PNG/JPEG/WEBP/BMP/GIF | PNG, JPEG, WEBP |
| JSON | CSV, TXT |
| HTML | TXT |

Image, CSV/JSON, and TXT/HTML/JSON conversions run in the browser. Everything involving PDF or Office files runs in the Bun server.

What the document engines keep:

- PDF input: text in reading order, headings, paragraphs, tables, and two-column pages. PDF to PPTX places every text segment at its original position, one slide per page. PDF to XLSX writes one sheet per page.
- DOCX input: headings, numbered and bulleted lists, tables, text boxes, and page breaks.
- XLSX input: every visible sheet, shared and inline strings, dates, percentages, booleans, and cached formula results. XLSX to CSV writes one file per sheet.
- PPTX input: slide titles, text, and tables in slide order.
- PDF output: word wrapping, pagination, bordered tables, and Chinese, Japanese, and Korean text.

What they do not keep: images, charts, colors, fonts, and exact page layout. Scanned PDFs need OCR, which is not included. Password-protected files and the legacy binary formats (`.doc`, `.xls`, `.ppt`) are rejected with a message. See [Native Converter Design](docs/native-converters.md) for details and limits.

## Runtime requirements

Install [Bun](https://bun.sh) on the host running the app. The project itself has no third-party package dependencies and does not invoke Poppler, LibreOffice, FFmpeg, or other external converter binaries.

## Run

```sh
bun run start
```

Then open `http://localhost:3000`. Set `PORT` to use another port.

Files can also be converted from the command line; the formats come from the file extensions:

```sh
bun cli.js report.pdf report.docx
bun cli.js budget.xlsx budget.pdf
```

## Test

```sh
bun test
```

## License

GPL-3.0-or-later. This keeps the project compatible with future GPL-covered converter code.
