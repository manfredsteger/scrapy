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

## System-Architektur

### Frontend-Architektur
- **Framework**: React 18 mit TypeScript, gebündelt via Vite
- **Routing**: Wouter für leichtgewichtiges Client-seitiges Routing
- **State Management**: TanStack Query (React Query) für Server-State-Caching und Synchronisation
- **UI-Komponenten**: Shadcn/ui Komponentenbibliothek basierend auf Radix UI mit Tailwind CSS
- **Styling**: Tailwind CSS mit CSS-Variablen für Theming (Dark/Light Mode)
- **Internationalisierung**: Eigene i18n-Implementierung mit Deutsch als Standardsprache

### Backend-Architektur
- **Runtime**: Node.js mit Express.js
- **Sprache**: TypeScript kompiliert mit tsx (Entwicklung), esbuild (Produktion)
- **API-Design**: RESTful Endpunkte mit Zod-Schema-Validierung
- **Web Scraping**: Native Fetch API mit JSDOM für HTML-Parsing und Inhaltsextraktion

### Datenspeicherung
- **Datenbank**: PostgreSQL mit Drizzle ORM
- **Schema-Speicherort**: `shared/schema.ts` enthält alle Tabellendefinitionen
- **Migrationen**: Verwaltet via Drizzle Kit mit `db:push` Befehl
- **Speichermuster**: Repository-Pattern implementiert in `server/storage.ts`

### Projektstruktur
```
├── client/           # React Frontend-Anwendung
│   └── src/
│       ├── components/   # UI-Komponenten (custom + shadcn/ui)
│       ├── hooks/        # Custom React Hooks
│       ├── lib/          # Utilities (i18n, queryClient)
│       └── pages/        # Seiten-Komponenten
├── server/           # Express Backend
│   ├── routes.ts     # API-Route-Handler
│   ├── storage.ts    # Datenbank-Zugriffsschicht
│   └── db.ts         # Datenbankverbindung
├── shared/           # Gemeinsamer Code (Client/Server)
│   ├── schema.ts     # Drizzle Schema + Zod Typen
│   └── routes.ts     # API-Vertragsdefinitionen
└── migrations/       # Datenbankmigrationen
```

### Wichtige Design-Entscheidungen
- **Monorepo-Struktur**: Client, Server und gemeinsamer Code in einem Repository für Typsicherheit
- **Geteilte Typ-Verträge**: Zod-Schemas in `shared/` sichern API-Typsicherheit zwischen Frontend und Backend
- **Komponentenbibliothek**: Shadcn/ui bietet barrierefreie, anpassbare Komponenten ohne externe Abhängigkeiten
- **Build-Optimierung**: Produktions-Builds bündeln kritische Abhängigkeiten für schnellere Startzeiten

## RAG Pack Feature

Die Anwendung enthält ein umfassendes RAG Pack Generierungssystem für AI/RAG-Workflows:

### Chunking-System
- Token-basierte Aufteilung mit `gpt-tokenizer` für präzise GPT-4 Token-Schätzung
- Konfigurierbare Ziel-Tokens (Standard 350), Überlappungs-Tokens (Standard 55), Mindest-Tokens (Standard 50)
- Satzbasierte Überlappung für sauberere Chunk-Grenzen
- Überschriften-Hierarchie-Erhaltung für semantischen Kontext
- SHA256-Hashes für Chunk-Integritätsprüfung
- **Tabellen-Erhaltung**: Tabellen als vollständige Chunks mit Kopfzeilen, Zeilen und Beschriftung
- **Code-Block-Erhaltung**: Code-Blöcke bleiben intakt mit Spracherkennung
- **Multi-Sprach-Support**: Verbesserte CJK (Chinesisch/Japanisch/Koreanisch) Token-Zählung
- **Qualitätsprüfungen**: Automatische Qualitätsbewertung mit Warnungen für kurze/leere Chunks

### Deduplizierung
- Exakte Duplikat-Erkennung via SHA256 Content-Hash-Vergleich
- Near-Duplikat-Erkennung mit Jaccard-Ähnlichkeit (konfigurierbarer Schwellenwert 0.7-1.0)
- Duplikate markiert aber für Referenz erhalten

### AI-Features (benötigt OPENAI_API_KEY)
- **Embeddings-Generierung**: Batch-Verarbeitung mit Retry-Logik, unterstützt text-embedding-3-small/large Modelle
- **Metadaten-Anreicherung**: 
  - Keyword-Extraktion (5-10 pro Chunk)
  - Zusammenfassungs-Generierung (1-2 Sätze)
  - Kategorie-Erkennung (technical, tutorial, news, product, documentation, blog, other)
  - Named Entity Extraction (Person, Organisation, Ort, Produkt)

### RAG Pack Export-Format
Der ZIP-Export enthält:
- `manifest.json` - Pack-Metadaten mit Version, Anzahlen und Prüfsummen
- `documents.jsonl` - Dokument-Level Metadaten (ein JSON-Objekt pro Zeile)
- `chunks.jsonl` - Alle Text-Chunks mit vollständigen Metadaten (ein JSON-Objekt pro Zeile)
- `schema/` Ordner mit JSON-Schemas zur Validierung

### Export-Formate
- **JSON**: Vollständiges RAG Pack als ZIP mit Manifest und Schema
- **CSV**: Streaming-Export mit chunk_id, text, url, heading, tokens, quality, keywords
- **Parquet**: Spaltenformat via parquetjs-lite für große Datasets
- **Inkrementell**: Nur neue/geänderte Chunks seit letztem Export

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

## Externe Abhängigkeiten

### Datenbank
- **PostgreSQL**: Hauptdatenspeicher, Verbindung via `DATABASE_URL` Umgebungsvariable
- **Drizzle ORM**: Typsichere Datenbankabfragen mit Schema-first Ansatz
- **connect-pg-simple**: Session-Speicherung für Express (falls Sessions aktiviert)

### Frontend-Bibliotheken
- **Radix UI**: Headless UI-Primitives für Barrierefreiheit
- **TanStack Query**: Async State-Management
- **Tailwind CSS**: Utility-first Styling
- **Lucide React**: Icon-Bibliothek
- **date-fns**: Datum-Formatierung

### Backend-Bibliotheken
- **Express.js**: HTTP-Server-Framework
- **JSDOM**: Server-seitiges DOM-Parsing für Inhaltsextraktion
- **Zod**: Runtime-Typ-Validierung
- **drizzle-zod**: Brücke zwischen Drizzle-Schemas und Zod-Validierung

### Entwicklungswerkzeuge
- **Vite**: Entwicklungsserver und Build-Tool
- **tsx**: TypeScript-Ausführung für Entwicklung
- **esbuild**: Produktions-Bundling für Server-Code
- **Drizzle Kit**: Datenbank-Migrationswerkzeuge

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
# Anwendung läuft auf http://localhost:3333
```