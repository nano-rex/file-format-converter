# Native Converter Design

This project implements conversion logic directly in the repository instead of copying source from LibreOffice, Poppler, FFmpeg, or other converter projects.

The approach is:

- Use public file format structures and high-level converter behavior as references.
- Write compact, project-owned implementations for the conversion paths we can support reliably.
- Avoid calling external converter programs from the app runtime.
- Keep unsupported conversions explicit instead of silently producing misleading output.

## Pipeline

Every reader produces the same document model, and every writer consumes it, so a new format only needs one reader or one writer:

```
{ title, source, pages: [{ name?, width, height, blocks, items? }] }
```

A block is a `heading` (with a level), a `paragraph`, or a `table` of string cells. A page is a PDF page, a worksheet, a slide, or a page-break section of a Word document. PDF pages also carry `items`, the positioned text segments used by the PPTX writer.

| File | Role |
| --- | --- |
| `src/convert.js` | Entry point: content sniffing, the conversion table, TXT/HTML/CSV/JSON output |
| `src/pdf-reader.js` | PDF parsing and text extraction |
| `src/pdf-layout.js` | Lines, columns, paragraphs, headings, and tables from positioned text |
| `src/pdf-writer.js` | PDF output with wrapping, pagination, and tables |
| `src/docx.js`, `src/xlsx.js`, `src/pptx.js` | OpenXML readers and writers |
| `src/zip.js`, `src/xml.js` | ZIP container and XML helpers |

The input format is decided by the file content (PDF header, ZIP parts), so a wrong or missing extension still converts.

## PDF reader

- Cross-reference tables, cross-reference streams, hybrid files, and object streams. If the table is missing or wrong the file is scanned for objects instead.
- Filters: Flate (with PNG and TIFF predictors), LZW, ASCII85, ASCIIHex, RunLength.
- Encryption: the standard security handler with RC4, AES-128, and AES-256 (revisions 2 to 6), for files that open without a password.
- Fonts: ToUnicode maps, WinAnsi/MacRoman/Standard encodings with `Differences` and glyph names, composite fonts, and Unicode CMaps.
- Text state: all positioning and spacing operators, form XObjects, page rotation, and crop boxes.

Layout analysis groups glyphs into lines, splits lines into cells at wide gaps, orders two-column prose, merges wrapped lines into paragraphs, marks larger text as headings, and aligns consecutive multi-cell lines into table columns.

Known limits:

- No OCR: scanned pages and fonts without a Unicode mapping yield no text, and the conversion reports that.
- No rendering: PDF pages cannot be converted to images, and images inside PDFs are dropped.
- Tables are found from text alignment, not ruling lines. Cells that wrap onto several lines become several rows, and a table sitting beside a prose column can be merged with it.
- Files that need a password to open are rejected.

## OpenXML

Readers resolve parts through the package relationships and match XML elements by local name, so files written by Word, Excel, PowerPoint, LibreOffice, Google Docs, and WPS are handled the same way.

- DOCX reader: heading styles, list numbering, tables (including merged cells and nested tables as text), text boxes, tabs, line and page breaks; tracked deletions are skipped.
- XLSX reader: every visible sheet, shared and inline strings, date and time formats (1900 and 1904 systems), percentages, booleans, and cached formula values.
- PPTX reader: titles, text shapes, grouped shapes, and tables.
- Writers produce complete packages, including styles for DOCX and the slide master, layout, and theme PowerPoint requires for PPTX. Characters that are invalid in XML are removed so Office does not report the file as corrupt.

Known limits:

- No images, charts, comments, headers, footers, footnotes, or speaker notes.
- No character formatting beyond headings and fully bold paragraphs.
- Formulas are not evaluated; the value saved by the spreadsheet application is used.
- Number formats other than dates and percentages are not applied, so `1234.5` is not rendered as `$1,234.50`.

## PDF writer

Lays the document model out on pages with word wrapping, pagination, and bordered tables whose columns shrink to fit the page. Latin text uses the built-in Helvetica fonts. Chinese, Japanese, and Korean text uses the standard CJK fonts that PDF viewers substitute locally, so no font data is embedded. Other scripts (for example Cyrillic, Arabic, Thai) are not supported yet and are written as `?`.

## Not implemented

- Legacy binary DOC, XLS, and PPT
- PDF to image, and image extraction from documents
- Audio and video transcoding
