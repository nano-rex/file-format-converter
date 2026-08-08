# File Format Converter

Local file format converter with a browser frontend and a Bun server. The app has no npm package dependencies and no CDN or remote conversion service calls.

## Current conversions

- Browser-native: PNG/JPEG/WEBP/BMP/GIF image input to PNG/JPEG/WEBP output, CSV to JSON, JSON to CSV, TXT to HTML, HTML to TXT, TXT to JSON, JSON to TXT
- PDF: PDF to PNG/JPEG/TXT through Poppler, PDF to DOCX/XLSX through Poppler plus LibreOffice, PDF to PPTX as one rendered page per slide
- Office: TXT to DOCX/PDF, DOC to DOCX/PDF, DOCX to PDF/TXT, PPT to PPTX, PPTX to PDF through LibreOffice
- Spreadsheet: XLS to XLSX/CSV/JSON, XLSX to CSV/JSON, CSV to XLSX through LibreOffice
- Media: MP4/WEBM/MKV/MOV and MP3/WAV/FLAC/OGG conversions through FFmpeg

## Runtime requirements

Install these local command-line tools on the host running the app:

- Bun
- LibreOffice, available as `soffice`
- Poppler tools, available as `pdftoppm` and `pdftotext`
- FFmpeg

The JavaScript project itself has no third-party package dependencies.

## Run

```sh
bun run start
```

Then open `http://localhost:3000`.

## License

GPL-3.0-or-later. This keeps the project compatible with future GPL-covered converter code.
