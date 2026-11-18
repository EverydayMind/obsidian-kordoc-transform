# KorDoc Transform (KorDoc 문서변환기)

[한국어](README.ko.md)

Convert Korean office documents to Markdown notes inside Obsidian Desktop, preview and edit HWPX, and export Markdown back to HWPX. Everything runs locally and offline; the conversion engine is bundled.

The interface and the agent tool wording follow the app language: Korean when Obsidian is set to Korean, English otherwise. This is an unofficial plugin built on the MIT-licensed [kordoc](https://github.com/chrisryugj/kordoc) library (bundled engine version 4.24.59; plugin version 4.24.64).

## Features

- **Convert to Markdown:** HWP, HWPX, HWPML, PDF, Excel (XLS/XLSX), Word (DOCX) and PowerPoint (PPTX). Images are extracted next to the note; tables, footnotes and headings are kept. Choose the output folder, page range, frontmatter and how layout tables are handled.
- **Batch and watch:** convert several files at once, or watch a vault folder and convert new documents automatically (opt-in).
- **HWPX preview and editing:** open an HWPX file as a full-page preview and edit paragraph, heading and table-cell text.
- **Export to HWPX:** save the current Markdown note as HWPX using an official-document preset, paper size, orientation, columns, font family and approval box settings.
- **Document tools:** compare two documents, analyse and fill form fields, place stamps or signatures, redact personal information, extract tables, and produce structure JSON, per-page text, RAG chunks, SVG and layout HTML.
- **Password-protected HWPX/HWP** can be opened with a one-time password prompt (the password is never stored).
- **For other plugins and agents:** a versioned document provider API, and an optional local MCP server that you start from the command palette.
- **OCR (optional add-on, Windows x64):** text OCR for images and scanned PDFs and formula OCR for PDFs. See [OCR add-on](#ocr-add-on).

## Installation

Install **KorDoc Transform** from Community plugins. For a manual installation, copy `main.js`, `manifest.json` and `styles.css` from a release into `.obsidian/plugins/kordoc-transform/` and enable the plugin.

## Usage

Commands (command palette):

- Convert an external document to Markdown (file picker)
- Convert the current file to Markdown
- HWPX preview / run an HWPX edit command
- Export the current Markdown note to HWPX
- Open document tools
- Start or stop the local MCP server (shows connection details)

You can also right-click a supported file in the file explorer. Settings cover the output folders, image extraction, frontmatter, overwrite rules, output format, page range, HWPX export options, folder auto-conversion, a completion webhook and OCR.

## OCR add-on

OCR needs native libraries (ONNX Runtime, sharp, PDFium) and recognition models of about 200 MB, which cannot be shipped through the community directory. They come as a separate ZIP attached to each GitHub release.

1. Download `kordoc-transform-ocr-pack-<engine version>-windows-x64.zip` from the release that matches your installed plugin version. The pack is named after the bundled kordoc engine version, which can differ from the plugin version.
2. Extract it into `.obsidian/plugins/kordoc-transform/` so that a `runtime/` folder appears next to `main.js`.
3. Restart Obsidian, then enable text or formula OCR in the plugin settings.

The plugin uses the pack only when its engine version, platform and file hashes match; otherwise OCR stays off and the plugin tells you why. Install the matching pack again after every plugin update. Only Windows x64 packs are provided.

## Tools for AI agents

You can skip this section if you don't use an AI agent in Obsidian.

KorDoc Transform exposes an agentinterop v1 capability provider on its plugin instance. A compatible agent host can read the tool definitions and call them after you approve them in the host. The tools read documents without changing them: `get_document_info`, `read_document`, `read_tables`, `read_form_fields`, `compare_documents` and `lint_document`, among others. This is separate from the optional local MCP server, which serves agents outside Obsidian.

agentinterop v1 is the author's own convention, not an official or widely recognized standard. It lets an Obsidian plugin that runs an AI agent discover tools offered by other plugins through an MCP-like API, without those plugins knowing about any particular agent host.

What this gives you:

- **No coupling between plugins.** The provider is a plain object on the plugin instance. This plugin does not import or depend on any agent plugin, and it works the same when none is installed.
- **Everything stays local.** A tool call is an in-process function call inside Obsidian. There is no server to start, no port to open and no network request.
- **You stay in control.** A host shows a plugin's tools to the model only after you approve them. Each tool declares its effect (all `read` here), so the host knows that none of these tools changes a file.
- **A short tool list for the model.** Keywords and groups let a host offer a tool only when the request is about it, which matters for small models.

**Verbex** is currently the only agent host that implements agentinterop v1: [EverydayMind/obsidian-verbex](https://github.com/EverydayMind/obsidian-verbex).

## Limitations

- Desktop only.
- Conversion quality depends on how the document was made. Complex layouts, scanned pages without the OCR add-on, and handwriting may need manual correction.
- HWPX editing changes text in paragraphs, headings and table cells; it does not restructure documents. HWP 5.0 binary files are not generated.
- Without the OCR add-on, large documents are converted one at a time on the main thread, so Obsidian can pause briefly during big conversions.

## Disclosures

- **Files:** reads the documents you select (or that appear in a watched folder you configured) and writes the converted notes, extracted images, exported HWPX files and diagnostics into the vault folders set in the settings.
- **Network:** none by default. The local MCP server listens on the loopback interface only and only after you start it. If you configure a completion webhook, the plugin sends the file name, result path and success flag to that URL. The engine runs in offline mode and does not download anything.
- **Native code:** only the optional OCR add-on runs native code, from the `runtime/` folder you installed yourself.
- **Bundled code and data:** `main.js` contains the kordoc engine, PDF.js with its CMaps and standard fonts, and other open-source libraries. Their licences are at the top of `main.js` and in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); model and native-library licences are inside the OCR add-on.

## License

MIT, see [LICENSE](LICENSE).

---

**Verbex**, an AI agent plugin for Obsidian that works together with this plugin, is available at [EverydayMind/obsidian-verbex](https://github.com/EverydayMind/obsidian-verbex).
