# Native Converter Design

This project implements conversion logic directly in the repository instead of copying source from LibreOffice, Poppler, FFmpeg, or other converter projects.

The approach is:

- Use public file format structures and high-level converter behavior as references.
- Write compact, project-owned implementations for the conversion paths we can support reliably.
- Avoid calling external converter programs from the app runtime.
- Keep unsupported full-fidelity conversions explicit instead of silently producing misleading output.

## Current Native Engines

### ZIP/OpenXML

DOCX, XLSX, and PPTX are ZIP packages containing XML parts. The app includes a minimal ZIP reader/writer and writes the OpenXML package parts needed for straightforward text documents, first-sheet spreadsheets, and simple slide decks.

Supported paths:

- CSV to XLSX
- XLSX to CSV
- XLSX to JSON
- TXT to DOCX
- DOCX to TXT
- PDF text to DOCX/XLSX/PPTX

Known limits:

- No formula evaluation
- No chart preservation
- No comments, macros, embedded media, tracked changes, or advanced styles
- Only the first worksheet is read

### PDF

The native PDF support is deliberately limited. The app can write simple text PDFs and can extract text from PDFs that expose text drawing operators in readable streams.

Supported paths:

- TXT to PDF
- DOCX to PDF through extracted text
- PDF to TXT for simple text PDFs
- PDF to DOCX/XLSX/PPTX through extracted text

Known limits:

- No raster rendering to PNG/JPEG yet
- No OCR for scanned documents
- No full layout reconstruction
- Limited filter and encoding support

## Planned Native Work

- A broader PDF parser with more filters and text encodings
- Basic image extraction from PDFs
- More complete XLSX shared string, date, number, and formula handling
- PPTX text extraction and simple PPTX-to-PDF rendering
- Native media container parsing where small, safe transformations are possible
