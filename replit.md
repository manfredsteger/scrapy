# MapScraper Pro

## Overview

MapScraper Pro is an enterprise-grade web content crawler and sitemap scraper built with a React frontend and Express backend. The application discovers sitemaps from websites, extracts URLs, and performs deep content scraping to capture structured DOM data including text, images, and videos. It supports multi-language interfaces (German/English) and provides project-based organization for managing multiple scraping jobs.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript, bundled via Vite
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query (React Query) for server state caching and synchronization
- **UI Components**: Shadcn/ui component library built on Radix UI primitives with Tailwind CSS
- **Styling**: Tailwind CSS with CSS variables for theming (light/dark mode support)
- **Internationalization**: Custom i18n implementation with German as default language

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript compiled with tsx for development, esbuild for production
- **API Design**: RESTful endpoints with Zod schema validation for request/response types
- **Web Scraping**: Native fetch API with JSDOM for HTML parsing and content extraction

### Data Storage
- **Database**: PostgreSQL with Drizzle ORM
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Migrations**: Managed via Drizzle Kit with `db:push` command
- **Storage Pattern**: Repository pattern implemented in `server/storage.ts` with DatabaseStorage class

### Project Structure
```
├── client/           # React frontend application
│   └── src/
│       ├── components/   # UI components (custom + shadcn/ui)
│       ├── hooks/        # Custom React hooks
│       ├── lib/          # Utilities (i18n, queryClient)
│       └── pages/        # Page components
├── server/           # Express backend
│   ├── routes.ts     # API route handlers
│   ├── storage.ts    # Database access layer
│   └── db.ts         # Database connection
├── shared/           # Shared code between client/server
│   ├── schema.ts     # Drizzle schema + Zod types
│   └── routes.ts     # API contract definitions
└── migrations/       # Database migrations
```

### Key Design Decisions
- **Monorepo Structure**: Client, server, and shared code in single repository for type safety across boundaries
- **Shared Type Contracts**: Zod schemas in `shared/` ensure API type safety between frontend and backend
- **Component Library**: Shadcn/ui provides accessible, customizable components without external dependencies
- **Build Optimization**: Production builds bundle critical dependencies to reduce cold start times

## RAG Pack Feature

The application includes a comprehensive RAG Pack generation system for AI/RAG workflows:

### Chunking System
- Token-based splitting using `gpt-tokenizer` for accurate GPT-4 token estimation
- Configurable target tokens (default 350), overlap tokens (default 55), and minimum chunk tokens (default 50)
- Sentence-based overlap for cleaner chunk boundaries
- Heading hierarchy preservation for semantic context
- SHA256 hashes for chunk integrity verification
- **Table Preservation**: Tables extracted as complete chunks with headers, rows, and caption metadata
- **Code Block Preservation**: Code blocks kept intact with language detection
- **Multi-Language Support**: Improved CJK (Chinese/Japanese/Korean) token counting
- **Quality Checks**: Automatic quality assessment with warnings for short/empty chunks

### Deduplication
- Exact duplicate detection via SHA256 content hash comparison
- Near-duplicate detection using Jaccard similarity (configurable threshold 0.7-1.0)
- Duplicates marked but preserved for reference

### AI Features (requires OPENAI_API_KEY)
- **Embeddings Generation**: Batch processing with retry logic, supports text-embedding-3-small/large models
- **Metadata Enrichment**: 
  - Keywords extraction (5-10 per chunk)
  - Summary generation (1-2 sentences)
  - Category detection (technical, tutorial, news, product, documentation, blog, other)
  - Named entity extraction (person, organization, location, product)

### RAG Pack Export Format
The ZIP export includes:
- `manifest.json` - Pack metadata with version, counts, and checksums
- `documents.jsonl` - Document-level metadata (one JSON object per line)
- `chunks.jsonl` - All text chunks with full metadata (one JSON object per line)
- `schema/` folder with JSON schemas for validation

### Export Formats
- **JSON**: Full RAG Pack as ZIP with manifest and schema
- **CSV**: Streaming export with chunk_id, text, url, heading, tokens, quality, keywords
- **Parquet**: Columnar format via parquetjs-lite for large datasets
- **Incremental**: Only new/changed chunks since last export

### API Endpoints
- `POST /api/projects/:id/chunks` - Generate chunks from scraped content
- `GET /api/projects/:id/chunks/stream` - SSE endpoint for real-time progress
- `GET /api/projects/:id/rag-pack` - Download RAG Pack as ZIP file
- `GET /api/projects/:id/export/csv` - Download as CSV
- `GET /api/projects/:id/export/parquet` - Download as Parquet
- `GET /api/projects/:id/export/incremental` - Get only changed chunks

## Advanced Scraping Features

### Rate Limiting
- Auto-adjustment on 429 (Too Many Requests) responses
- Configurable base delay (100-10000ms), max delay (1000-60000ms), and backoff multiplier (1.5-5x)
- Gradual recovery after successful requests

### Proxy Rotation
- Support for HTTP, HTTPS, and SOCKS5 proxies via `undici` ProxyAgent
- Round-robin rotation through proxy list
- Automatic failure detection with cooldown periods
- Optional authentication (username/password)

### Structured Data Extraction
- **JSON-LD**: All `<script type="application/ld+json">` content parsed
- **Schema.org Microdata**: itemscope/itemtype/itemprop attributes extracted
- **OpenGraph**: All `og:*` meta tags captured
- **Twitter Cards**: All `twitter:*` meta tags captured

## External Dependencies

### Database
- **PostgreSQL**: Primary data store, connection via `DATABASE_URL` environment variable
- **Drizzle ORM**: Type-safe database queries with schema-first approach
- **connect-pg-simple**: Session storage for Express (if sessions are enabled)

### Frontend Libraries
- **Radix UI**: Headless UI primitives for accessibility
- **TanStack Query**: Async state management
- **Tailwind CSS**: Utility-first styling
- **Lucide React**: Icon library
- **date-fns**: Date formatting utilities

### Backend Libraries
- **Express.js**: HTTP server framework
- **JSDOM**: Server-side DOM parsing for content extraction
- **Zod**: Runtime type validation
- **drizzle-zod**: Bridge between Drizzle schemas and Zod validation

### Development Tools
- **Vite**: Development server and build tool
- **tsx**: TypeScript execution for development
- **esbuild**: Production bundling for server code
- **Drizzle Kit**: Database migration tooling

## Docker Setup (Lokale Entwicklung)

Die Anwendung kann vollständig offline mit Docker betrieben werden:

### Dateien
- `Dockerfile` - Multi-Architektur Image (AMD64, ARM64, ARMv7)
- `docker-compose.yml` - Entwicklungsumgebung
- `docker-compose.prod.yml` - Produktions-Overrides
- `Makefile` - Entwickler-Befehle
- `DOCKER-README.md` - Ausführliche Dokumentation

### Wichtige Make-Befehle
```bash
make dev        # Startet Entwicklungsumgebung
make start      # Startet im Hintergrund
make stop       # Stoppt Container
make reset      # Kompletter Neustart (löscht alles)
make db-reset   # Nur Datenbank zurücksetzen
make logs       # Live-Logs anzeigen
make help       # Alle Befehle anzeigen
```

### Architektur-Support
- linux/amd64 (Intel/AMD)
- linux/arm64 (Apple Silicon, Raspberry Pi 4+)
- linux/arm/v7 (Raspberry Pi 3, ältere ARM)