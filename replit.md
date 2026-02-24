# MapScraper Pro

## Overview

MapScraper Pro is a professional web scraping application designed for AI/LLM workflows, featuring RAG (Retrieval Augmented Generation) Pack generation. It automates the discovery of website sitemaps, extracts URLs, and performs deep content scraping to capture structured DOM data, including text, images, and videos. The application supports project-based and single-page scraping, comprehensive RAG pack generation with advanced chunking and AI enrichment, and multi-format exports.

Key Capabilities:
- **Project-based and Single-page Scraping**: Manage multiple scraping projects or quickly process individual URLs.
- **RAG Pack Generation**: Token-based chunking, deduplication, and AI enrichment for optimized AI/LLM consumption.
- **Multi-Format Export**: Supports JSON, CSV, Parquet, and incremental exports.
- **Modular Scraper System**: Adaptable scraping logic for various website types (e.g., Wiki.js, WordPress, Moodle).
- **Advanced Scraping Features**: Includes rate limiting, proxy rotation, and structured data extraction (JSON-LD, Schema.org, OpenGraph).
- **User Interface**: Available in German and English with dark/light mode support.

## User Preferences

Preferred communication: Simple, everyday language (German).

## System Architecture

### High-Level Design
MapScraper Pro utilizes a monorepo structure, hosting both the React TypeScript frontend and the Node.js Express TypeScript backend, along with shared code, to ensure type safety and streamlined development.

### Frontend
- **Framework**: React 18 with TypeScript, bundled by Vite.
- **Routing**: Wouter for client-side navigation.
- **State Management**: TanStack Query for server-state caching.
- **UI Components**: Shadcn/ui based on Radix UI, styled with Tailwind CSS for a modern, accessible, and customizable design supporting dark/light modes.
- **Internationalization**: Custom implementation with German as the default language.
- **Performance Optimization**: Employs lazy-loading for content previews and separate React Queries to handle large datasets efficiently, reducing initial load times and improving responsiveness.

### Backend
- **Runtime**: Node.js with Express.js.
- **Language**: TypeScript, executed with `tsx` (development) and bundled with `esbuild` (production).
- **API**: RESTful endpoints with Zod schema validation for robust data integrity.
- **Web Scraping**: Leverages native Fetch API and JSDOM for HTML parsing and content extraction.
- **Modular Scraper System**: Features a `BaseScraper` class, a scraper registry for dynamic instantiation, and a website detector to identify CMS types (e.g., Wiki.js, WordPress, Moodle, Generic) and apply specialized scraping logic.

### Data Storage
- **Filesystem-First Architecture**: All scraped content, chunks, and PDFs stored on filesystem. DB only stores metadata and `hasScrapedData` flags.
- **Filesystem Storage** (`server/fileStorage.ts`): Primary storage for scraped content and chunks. Each page saved as `content.md` (Markdown) + `meta.json` (metadata with orderedElements, structuredData, linkedPdfs). PDFs and media downloaded during scraping into page-level `pdfs/` and `media/` folders. Chunks stored as `chunks.json` per project/single-page. Storage root: `./data/projects/{id}-{domain}/` (with `pages/` subdirectory, `chunks.json`, and `pdfs.json`) and `./data/single-pages/{id}-{domain}/` (with `chunks.json`). Page directories include SHA256 hash prefix (10 chars) of full URL to prevent path collisions.
- **PDF Reference Index** (`pdfs.json`): Project-level JSON file listing all referenced PDFs with URL, title, page URL, local path, and download status. Built automatically after scraping and RAG pack export. API: `GET /api/projects/:id/pdfs` (read/build), `POST /api/projects/:id/pdfs/rebuild` (force rebuild). PDFs downloaded during scraping are stored in page-level `pdfs/` directories; RAG pack export also saves downloaded PDFs to page directories for future reuse.
- **Chunk Storage**: Chunks saved to filesystem as `chunks.json` at project/single-page root (`data/projects/{id}-{domain}/chunks.json`, `data/single-pages/{id}-{domain}/chunks.json`). Helper functions `loadProjectChunks()` and `loadSinglePageChunks()` read from filesystem with DB fallback for backward compatibility. DB `chunks` column kept as empty `[]` after migration.
- **Markdown Conversion** (`server/markdownConverter.ts`): Converts `orderedElements` array to/from Markdown format, preserving headings, lists, tables, code blocks, blockquotes, and media references.
- **Database**: PostgreSQL, managed with Drizzle ORM. Stores project results with `hasScrapedData` flag (content on filesystem). No `scrapedData` JSONB or chunks stored in DB (migrated to filesystem).
- **Filesystem Loading**: `loadResultsWithFilesystem()` helper enriches project results with filesystem data on-demand for chunking and RAG pack export.
- **Schema Management**: Drizzle ORM defines database schemas in `shared/schema.ts`, with migrations handled by Drizzle Kit.
- **Access Pattern**: Repository pattern implemented in `server/storage.ts` for data access. API endpoints read from filesystem, no DB fallback needed post-migration.
- **Download Limits**: PDFs max 50MB each (10 per page), media max 10MB each (50 per page).
- **Storage Stats**: `GET /api/storage/stats` returns filesystem usage (total files, size).
- **Persistent RAG Pack Exports**: ZIP exports saved to `data/projects/{id}-{domain}/exports/` and tracked in `rag_pack_exports` DB table with 30-day retention. API: `GET /api/projects/:id/exports` (list), `GET /api/rag-pack/download/:downloadId` (download from filesystem), `DELETE /api/exports/:downloadId` (delete). Auto-cleanup of expired exports on server startup and daily. UI: "RAG Pack Versionen" button in Aktionsmenü shows export history with download/delete per version.

### RAG Pack Generation (v2.0)
- **Chunking System**: Fast character-based token estimation (`text.length / 4`), configurable target/overlap tokens, sentence-based overlap, preservation of heading hierarchy, tables, and code blocks. Includes SHA256 hashing for integrity and quality checks.
- **PDF Text Extraction**: Uses `pdf-parse` for text extraction from linked PDFs. Multi-stage quality validation: PDF signature check, garbage ratio analysis (<5%), real word detection (≥5 words), minimum length check. Valid PDFs are chunked as separate document entries; invalid/binary PDFs are tracked in `quality_report`.
- **Clean Title System**: Prevents URLs/filenames as titles. Fallback chain: PDF metadata → first heading → slugified filename. HTML titles cleaned of common suffixes.
- **Enhanced Document Metadata**: `file_type` (html/pdf), `file_name`, `description`, `category` (from URL path), `source_fingerprint`, `pdf_has_text_layer`, `total_pages`.
- **Deduplication**: Exact and near-duplicate detection using SHA256 and Jaccard similarity.
- **AI Enrichment**: Integration with OpenAI (requires `OPENAI_API_KEY`) for embeddings generation, keyword extraction, summary generation, category recognition, and named entity extraction.
- **Export Format**: RAG Packs v2.0 exported as ZIP archives containing `manifest.json` (with `quality_report`), `documents.jsonl`, `chunks.jsonl`, `assets.jsonl`, and JSON schemas. Quality report tracks: text layer stats, token statistics (min/max/avg), skipped binary PDFs list.
- **Performance**: All token estimation uses fast approximation (`text.length / 4`), no expensive `gpt-tokenizer` encode() calls in chunking pipeline.

### RAG Pack Converter
- **Standalone Converter**: Dedicated tab in main navigation (`/converter`) for processing arbitrary uploaded files into RAG Packs without requiring web scraping projects.
- **Supported File Types**: PDF (via pdf-parse with quality validation), text files (.txt, .md, .csv, .json, .xml, .yaml, etc.), HTML (via JSDOM DOM parsing), unsupported formats included as binary assets.
- **Source File Inclusion**: All uploaded files are included in the ZIP's `assets/` folder with an `assets.jsonl` manifest, regardless of whether text extraction succeeded. Files with successful extraction get `role: 'source_document'`; files without get `reason` explaining the failure.
- **File Upload**: Multer-based multipart upload with session management. Multiple uploads append to the same session via `sessionId` in form data. Filenames sanitized with `path.basename()` and character whitelist.
- **Processing Pipeline**: Full parity with project/single-page RAG Pack generation: text extraction → chunking (512 target tokens, 100 overlap) → SHA256+Jaccard deduplication (0.90 threshold) → OpenAI Embeddings (text-embedding-3-small, 1536 dimensions, if API key available) → AI Enrichment (keywords, summaries, categories, entities via gpt-4o-mini, if API key available).
- **Generation**: SSE-based progress tracking with `data: {"type": "init|progress|complete|error", ...}` format with phase indicators for deduplication, embeddings, and enrichment. Generates ZIP with `manifest.json` (v2.0 with quality_report), `documents.jsonl`, `chunks.jsonl`, `assets.jsonl`, `schemas/`, and `assets/` folder.
- **Persistent Storage**: `converter_exports` DB table stores saved RAG Packs with session info, source file list, and metadata. API: `POST /api/converter/exports/save`, `GET /api/converter/exports`, `GET /api/converter/exports/:id/files`, `DELETE /api/converter/exports/:id`.
- **Session Reload**: Saved exports can be reopened to load source files back into the converter for re-processing or adding more files.
- **Download Persistence**: Download endpoint checks both in-memory map and DB, surviving server restarts.
- **Storage**: Session files in `./data/converter/{sessionId}/uploads/`, generated ZIPs in `./data/converter/{sessionId}/`.
- **UI**: Drag-and-drop upload, file list with type icons, real-time progress bar, save/download/reset buttons, saved exports overview with download/reload/delete (with confirmation dialog).

## External Dependencies

### Database
- **PostgreSQL**: Primary data store.
- **Drizzle ORM**: TypeScript ORM for database interaction.
- **connect-pg-simple**: For Express session storage.

### Frontend Libraries
- **Radix UI**: Headless UI components.
- **TanStack Query**: Asynchronous state management.
- **Tailwind CSS**: Utility-first CSS framework.
- **Lucide React**: Icon library.
- **date-fns**: Date utility library.

### Backend Libraries
- **Express.js**: Web application framework.
- **JSDOM**: Server-side DOM parsing.
- **Zod**: Schema validation library.
- **drizzle-zod**: Integration between Drizzle and Zod.
- **undici**: HTTP/1.1, HTTP/2, and WebSockets client (used for proxy rotation).

### Development Tools
- **Vite**: Frontend build tool and development server.
- **tsx**: TypeScript execution for development.
- **esbuild**: Server-side code bundling for production.
- **Drizzle Kit**: Database migration tool.