# MapScraper Pro

## Überblick

MapScraper Pro ist ein professioneller Web-Scraper mit RAG Pack Generation für AI/LLM-Workflows. Die Anwendung entdeckt Sitemaps von Websites, extrahiert URLs und führt tiefes Content-Scraping durch, um strukturierte DOM-Daten zu erfassen - einschließlich Text, Bilder und Videos. Die Benutzeroberfläche unterstützt Deutsch und Englisch.

### Hauptfunktionen
- **Projekt-basiertes Scraping** - Verwaltung mehrerer Scraping-Projekte
- **Einzelseiten-Scraping** - Schnelles Scrapen einzelner URLs mit vollständiger RAG-Verarbeitung
- **RAG Pack Generation** - Token-basiertes Chunking, Deduplizierung, AI-Anreicherung
- **Multi-Format Export** - JSON, CSV, Parquet, Inkrementell
- **Dark/Light Mode** - Modernes UI-Design

## Benutzer-Präferenzen

Bevorzugte Kommunikation: Einfache, alltägliche Sprache (Deutsch).

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

### API Endpoints - Projekte
- `POST /api/projects/:id/chunks` - Chunks aus gescraptem Inhalt generieren
- `GET /api/projects/:id/chunks/stream` - SSE-Endpunkt für Echtzeit-Fortschritt
- `GET /api/projects/:id/rag-pack` - RAG Pack als ZIP herunterladen
- `GET /api/projects/:id/export/csv` - Als CSV exportieren
- `GET /api/projects/:id/export/parquet` - Als Parquet exportieren
- `GET /api/projects/:id/export/incremental` - Nur geänderte Chunks

## Einzelseiten-Scraping

Ermöglicht schnelles Scrapen einzelner URLs mit vollständiger RAG-Verarbeitung:

### Funktionsumfang
- Automatische Inhaltsextraktion (Text, Bilder, Videos)
- Vollständige Chunk-Generierung während des Scrapens
- Deduplizierung und Qualitätsprüfung
- RAG Pack Export für einzelne Seiten

### API Endpoints - Einzelseiten
- `GET /api/single-pages` - Alle Einzelseiten abrufen
- `POST /api/single-pages` - Neue Seite scrapen
- `GET /api/single-pages/:id` - Einzelseite abrufen
- `DELETE /api/single-pages/:id` - Einzelseite löschen
- `GET /api/single-pages/:id/rag-pack` - RAG Pack für Einzelseite

### Status-Progression
Während des Scrapens durchläuft eine Einzelseite folgende Status:
1. `pending` - Warten auf Verarbeitung
2. `scraping` - Inhalt wird extrahiert
3. `chunking` - Chunks werden generiert
4. `completed` - Fertig (oder `error` bei Fehlern)

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

Die Anwendung kann vollständig offline mit Docker betrieben werden.
Detaillierte Anleitung: Siehe `README.md` für vollständige Docker-Dokumentation.

### Dateien
- `Dockerfile` - Multi-Architektur Image (AMD64, ARM64, ARMv7)
- `docker-compose.yml` - Entwicklungsumgebung
- `docker-compose.prod.yml` - Produktions-Overrides
- `Makefile` - Entwickler-Befehle (verwendet Tabs, nicht Spaces!)
- `docker/init-db.sql` - Datenbank-Initialisierung
- `README.md` - Ausführliche Dokumentation mit Emojis

### Wichtige Make-Befehle
```bash
make dev        # Startet Entwicklungsumgebung
make start      # Startet im Hintergrund
make stop       # Stoppt Container
make restart    # Neustart aller Container
make logs       # Live-Logs anzeigen
make db-reset   # Datenbank zurücksetzen
make db-backup  # Datenbank-Backup erstellen
make db-shell   # PostgreSQL Shell öffnen
make status     # Container-Status anzeigen
make health     # Service-Gesundheit prüfen
make clean      # Docker-Ressourcen bereinigen
make reset      # Kompletter Neustart (löscht alles)
make prod       # Produktionsumgebung starten
make help       # Alle Befehle anzeigen
```

### Architektur-Support
- linux/amd64 (Intel/AMD Server)
- linux/arm64 (Apple Silicon M1/M2/M3, Raspberry Pi 4+)
- linux/arm/v7 (Raspberry Pi 3, ältere ARM-Geräte)

### Schnellstart
```bash
git clone <repo-url>
cd mapscraper-pro
make dev
# Anwendung läuft auf http://localhost:5000
```