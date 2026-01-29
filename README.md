# 🕷️ MapScraper Pro

> 🚀 Professioneller Web-Scraper mit RAG Pack Generation für AI/LLM-Workflows

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-green.svg)
![Docker](https://img.shields.io/badge/docker-supported-blue.svg)

---

## 📋 Inhaltsverzeichnis

- [✨ Features](#-features)
- [🖥️ Screenshots](#️-screenshots)
- [🐳 Docker Installation](#-docker-installation-empfohlen)
- [💻 Lokale Installation](#-lokale-installation)
- [🔧 Konfiguration](#-konfiguration)
- [📖 Verwendung](#-verwendung)
- [🤖 RAG Pack System](#-rag-pack-system)
- [🏗️ Architektur](#️-architektur)
- [📚 API Dokumentation](#-api-dokumentation)
- [🛠️ Entwicklung](#️-entwicklung)
- [❓ FAQ](#-faq)

---

## ✨ Features

### 🌐 Web Scraping
- 🔍 **Automatische Sitemap-Erkennung** - Findet alle Sitemaps einer Website
- 📄 **Intelligente Inhaltsextraktion** - Extrahiert Text, Bilder, Videos mit DOM-Struktur
- 🔄 **Rate Limiting** - Automatische Anpassung bei zu vielen Anfragen
- 🌍 **Proxy-Unterstützung** - Rotation durch mehrere Proxies

### 📦 RAG Pack Generation
- ✂️ **Token-basiertes Chunking** - Präzise Aufteilung für GPT-Modelle
- 🔗 **Überlappung** - Konfigurierbare Chunk-Überlappung für Kontext
- 📊 **Deduplizierung** - Erkennung von exakten und ähnlichen Duplikaten
- 🤖 **AI-Anreicherung** - Keywords, Zusammenfassungen, Kategorien (optional)

### 📤 Export-Formate
- 📁 **JSON** - Vollständiges RAG Pack als ZIP
- 📑 **CSV** - Tabellenformat für Excel/Google Sheets
- 🗄️ **Parquet** - Spaltenformat für große Datasets
- ⚡ **Inkrementell** - Nur neue/geänderte Chunks

### 🎨 Benutzeroberfläche
- 🌓 **Dark/Light Mode** - Modernes, augenfreundliches Design
- 🇩🇪 🇬🇧 **Mehrsprachig** - Deutsch und Englisch
- 📱 **Responsive** - Funktioniert auf Desktop und Tablet
- ⚡ **Echtzeit-Updates** - Live-Fortschrittsanzeige beim Scrapen

---

## 🐳 Docker Installation (Empfohlen)

### Voraussetzungen

- Docker 20.10 oder neuer
- Docker Compose v2.0 oder neuer
- 4GB RAM (empfohlen)

### 🚀 Schnellstart

```bash
# Repository klonen
git clone https://gitlab.com/dein-username/mapscraper-pro.git
cd mapscraper-pro

# Entwicklungsumgebung starten
make dev
```

Das war's! 🎉 Die Anwendung ist jetzt unter **http://localhost:5000** erreichbar.

### 📋 Alle Make-Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `make help` | 📖 Zeigt alle Befehle an |
| `make dev` | 🚀 Startet Entwicklungsumgebung (mit Logs) |
| `make start` | ▶️ Startet im Hintergrund |
| `make stop` | ⏹️ Stoppt alle Container |
| `make restart` | 🔄 Neustart aller Container |
| `make logs` | 📜 Zeigt Live-Logs an |
| `make db-reset` | 🗑️ Datenbank zurücksetzen |
| `make db-shell` | 💻 PostgreSQL Shell öffnen |
| `make db-backup` | 💾 Datenbank-Backup erstellen |
| `make clean` | 🧹 Docker-Ressourcen bereinigen |
| `make reset` | ♻️ Kompletter Neustart (alles löschen) |
| `make prod` | 🏭 Produktionsumgebung starten |
| `make status` | 📊 Container-Status anzeigen |
| `make health` | 🏥 Service-Gesundheit prüfen |

### 🏭 Produktions-Deployment

```bash
# Produktions-Image bauen und starten
make prod

# Oder manuell mit docker compose
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 🔧 Multi-Architektur

MapScraper Pro unterstützt mehrere Plattformen:

- ✅ **linux/amd64** - Standard Intel/AMD Server
- ✅ **linux/arm64** - Apple Silicon (M1/M2/M3), Raspberry Pi 4+
- ✅ **linux/arm/v7** - Raspberry Pi 3, ältere ARM-Geräte

```bash
# Multi-Arch Image bauen
make build-multi
```

---

## 💻 Lokale Installation

### Voraussetzungen

- Node.js 20 oder neuer
- npm 9 oder neuer
- PostgreSQL 14 oder neuer

### 📥 Installation

```bash
# Repository klonen
git clone https://gitlab.com/dein-username/mapscraper-pro.git
cd mapscraper-pro

# Abhängigkeiten installieren
npm ci --legacy-peer-deps

# Umgebungsvariablen konfigurieren
cp .env.example .env
# .env bearbeiten und DATABASE_URL setzen

# Datenbank-Schema erstellen
npm run db:push

# Entwicklungsserver starten
npm run dev
```

Die Anwendung läuft auf **http://localhost:5000** 🎉

---

## 🔧 Konfiguration

### Umgebungsvariablen

| Variable | Beschreibung | Standard |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL Verbindungs-URL | (erforderlich) |
| `SESSION_SECRET` | Geheimer Schlüssel für Sessions | (erforderlich) |
| `PORT` | Server-Port | `5000` |
| `NODE_ENV` | Umgebung (development/production) | `development` |
| `OPENAI_API_KEY` | Für AI-Anreicherung (optional) | - |

### 📁 .env Beispiel

```env
DATABASE_URL=postgresql://mapscraper:secret@localhost:5432/mapscraper
SESSION_SECRET=dein-super-geheimer-schluessel-hier
PORT=5000
NODE_ENV=development

# Optional: Für AI-Features (Embeddings, Keywords, Zusammenfassungen)
OPENAI_API_KEY=sk-...
```

---

## 📖 Verwendung

### 🌐 Neues Projekt erstellen

1. Klicke auf **"+ Neues Projekt"**
2. Gib einen Projektnamen und die Website-Domain ein
3. Klicke auf **"Speichern"**

### 🔍 Sitemaps entdecken

1. Wähle ein Projekt aus
2. Klicke auf **"Sitemaps entdecken"**
3. Wähle die gewünschten Sitemaps aus
4. Klicke auf **"URLs laden"**

### 📄 Inhalte scrapen

1. Klicke auf **"Alle Inhalte scrapen"**
2. Warte, bis alle URLs gescrapt wurden
3. Die Fortschrittsanzeige zeigt den aktuellen Status

### 📦 RAG Pack generieren

1. Klicke auf **"Chunks generieren"**
2. Wähle die gewünschten Export-Optionen
3. Klicke auf **"RAG Pack speichern"**

### ⚡ Einzelseiten-Scraping

Für schnelles Scrapen einer einzelnen Seite:

1. Gib die URL in das Eingabefeld ein
2. Klicke auf **"Seite scrapen"**
3. Die Seite wird automatisch gescrapt und in Chunks aufgeteilt

---

## 🤖 RAG Pack System

### 📊 Was ist ein RAG Pack?

Ein RAG Pack ist ein strukturiertes Datenpaket, optimiert für Retrieval-Augmented Generation (RAG) mit Large Language Models wie GPT-4.

### 📁 RAG Pack Struktur

```
rag-pack-domain.zip
├── manifest.json       # Metadaten zum Pack
├── documents.jsonl     # Dokument-Informationen
├── chunks.jsonl        # Alle Text-Chunks
└── schema/
    └── manifest.schema.json
```

### ✂️ Chunking-Einstellungen

| Einstellung | Standard | Beschreibung |
|-------------|----------|-------------|
| Ziel-Tokens | 350 | Gewünschte Chunk-Größe |
| Überlappung | 55 Tokens | Überlappung zwischen Chunks |
| Min. Tokens | 50 | Mindestgröße für Chunks |

### 🎯 Chunk-Typen

- `text` - Normaler Textinhalt
- `table` - Vollständige Tabellen
- `code` - Code-Blöcke
- `heading` - Überschriften mit Hierarchie

---

## 🏗️ Architektur

```
mapscraper-pro/
├── 📂 client/                 # React Frontend
│   └── src/
│       ├── components/        # UI-Komponenten
│       ├── hooks/             # React Hooks
│       ├── lib/               # Utilities, i18n
│       └── pages/             # Seiten-Komponenten
├── 📂 server/                 # Express Backend
│   ├── routes.ts              # API-Endpunkte
│   ├── storage.ts             # Datenbank-Zugriff
│   └── db.ts                  # DB-Verbindung
├── 📂 shared/                 # Gemeinsamer Code
│   ├── schema.ts              # Drizzle Schema + Typen
│   └── routes.ts              # API-Verträge
├── 📂 docker/                 # Docker-Konfiguration
│   └── init-db.sql            # DB-Initialisierung
├── 🐳 Dockerfile              # Container-Definition
├── 🐳 docker-compose.yml      # Entwicklung
├── 🐳 docker-compose.prod.yml # Produktion
└── 📋 Makefile                # Entwickler-Befehle
```

### 🛠️ Technologie-Stack

| Bereich | Technologie |
|---------|-------------|
| Frontend | React 18, TypeScript, Vite |
| UI | Shadcn/ui, Tailwind CSS, Radix UI |
| Backend | Node.js, Express.js |
| Datenbank | PostgreSQL 16, Drizzle ORM |
| Scraping | JSDOM, Native Fetch |
| Container | Docker, Docker Compose |

---

## 📚 API Dokumentation

### Projekte

```http
GET    /api/projects           # Alle Projekte
POST   /api/projects           # Neues Projekt
GET    /api/projects/:id       # Projekt abrufen
PATCH  /api/projects/:id       # Projekt aktualisieren
DELETE /api/projects/:id       # Projekt löschen
```

### Scraping

```http
POST   /api/scrape/discover    # Sitemaps entdecken
POST   /api/scrape/sitemap     # Sitemap laden
POST   /api/scrape/content     # Inhalte scrapen
```

### RAG Pack

```http
POST   /api/projects/:id/chunks     # Chunks generieren
GET    /api/projects/:id/rag-pack   # RAG Pack herunterladen
GET    /api/projects/:id/export/csv # CSV exportieren
```

### Einzelseiten

```http
GET    /api/single-pages           # Alle Einzelseiten
POST   /api/single-pages           # Neue Seite scrapen
GET    /api/single-pages/:id       # Seite abrufen
DELETE /api/single-pages/:id       # Seite löschen
GET    /api/single-pages/:id/rag-pack  # RAG Pack für Einzelseite
```

---

## 🛠️ Entwicklung

### 🔄 Entwicklungsworkflow

```bash
# Container starten mit Live-Reload
make dev

# In einem anderen Terminal: Logs beobachten
make logs

# Datenbank-Änderungen anwenden
make db-migrate

# Tests ausführen (falls vorhanden)
npm test
```

### 🐛 Debugging

```bash
# App-Shell öffnen
make shell

# Datenbank-Shell öffnen
make db-shell

# Container-Status prüfen
make status

# Gesundheitscheck
make health
```

### 📦 Neue Pakete installieren

```bash
# Im Container
make npm-install PKG=paketname

# Oder lokal
npm install paketname
```

---

## ❓ FAQ

### 🤔 Warum Docker?

Docker ermöglicht eine konsistente Entwicklungsumgebung auf allen Plattformen. Die Datenbank, Abhängigkeiten und Konfiguration sind bereits eingerichtet.

### 🔧 Makefile funktioniert nicht?

Stelle sicher, dass:
1. Du `make` installiert hast (`apt install make` auf Linux)
2. Das Makefile mit Tabs eingerückt ist (nicht Spaces)
3. Du im richtigen Verzeichnis bist

### 💾 Wie mache ich ein Backup?

```bash
make db-backup
# Backup wird in ./backups/ gespeichert
```

### 🔄 Wie stelle ich ein Backup wieder her?

```bash
make db-restore BACKUP=backup_20240101_120000.sql
```

### 🐳 Container startet nicht?

```bash
# Logs prüfen
make logs

# Alles neu starten
make reset
```

### 🔑 OpenAI API Key für AI-Features?

Füge `OPENAI_API_KEY=sk-...` zu deiner `.env` Datei hinzu oder setze die Umgebungsvariable im Docker Compose.

---

## 📜 Lizenz

MIT License - siehe [LICENSE](LICENSE)

---

## 🙏 Danke!

Danke, dass du MapScraper Pro verwendest! 🎉

Bei Fragen oder Problemen, erstelle gerne ein Issue im GitLab Repository.

---

<p align="center">
  Made with ❤️ in Germany 🇩🇪
</p>
