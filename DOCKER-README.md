# MapScraper Pro - Docker Setup

Vollständig offline lauffähige Entwicklungsumgebung für MapScraper Pro.

## Voraussetzungen

- **Docker Desktop** (Windows/macOS) oder **Docker Engine** (Linux)
- **Docker Compose** v2.x (in Docker Desktop enthalten)
- **Make** (optional, aber empfohlen)

### Installation Docker

**macOS (Apple Silicon & Intel):**
```bash
brew install --cask docker
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

**Windows:**
1. Docker Desktop von https://docker.com herunterladen
2. WSL2 Backend aktivieren

## Schnellstart

### Mit Make (empfohlen)

```bash
# Entwicklungsumgebung starten
make dev

# Im Hintergrund starten
make start

# Logs anzeigen
make logs

# Stoppen
make stop
```

### Ohne Make

```bash
# Starten
docker compose up --build

# Im Hintergrund
docker compose up -d --build

# Stoppen
docker compose down
```

## Alle Make-Befehle

| Befehl | Beschreibung |
|--------|--------------|
| `make help` | Zeigt alle verfügbaren Befehle |
| `make dev` | Startet Entwicklungsumgebung (Vordergrund) |
| `make start` | Startet Container im Hintergrund |
| `make stop` | Stoppt alle Container |
| `make restart` | Neustart aller Container |
| `make logs` | Zeigt Live-Logs |
| `make logs-app` | Zeigt nur App-Logs |
| `make logs-db` | Zeigt nur Datenbank-Logs |
| `make db-reset` | Setzt Datenbank zurück (**löscht alle Daten!**) |
| `make db-shell` | Öffnet PostgreSQL Shell |
| `make db-backup` | Erstellt Datenbank-Backup |
| `make db-restore BACKUP=datei.sql` | Stellt Backup wieder her |
| `make clean` | Stoppt Container, löscht Images |
| `make clean-all` | Löscht ALLES (Container, Images, Volumes) |
| `make reset` | Kompletter Reset und Neustart |
| `make build` | Baut Produktions-Image |
| `make prod` | Startet Produktionsumgebung |
| `make shell` | Öffnet Shell im App-Container |
| `make status` | Zeigt Container-Status |
| `make health` | Prüft Gesundheit aller Services |

## Architektur-Support

Diese Konfiguration unterstützt:

| Architektur | Beispiel-Systeme |
|-------------|------------------|
| `linux/amd64` | Intel/AMD PCs, Server |
| `linux/arm64` | Apple Silicon (M1/M2/M3), Raspberry Pi 4+ |
| `linux/arm/v7` | Raspberry Pi 3, ältere ARM-Geräte |

Docker erkennt automatisch die richtige Architektur.

### Multi-Architektur Build

Für eigene Registry/Deployment:
```bash
make build-multi
```

## Datenbank

### Verbindungsdaten (lokal)

| Parameter | Wert |
|-----------|------|
| Host | `localhost` |
| Port | `5433` (auf Container-Port 5432 gemappt, siehe `docker-compose.yml`) |
| Datenbank | `mapscraper` |
| Benutzer | `mapscraper` |
| Passwort | `mapscraper_secret` |

### Direkter Zugriff

```bash
# PostgreSQL Shell
make db-shell

# Oder direkt
docker compose exec db psql -U mapscraper -d mapscraper
```

### Backup & Restore

```bash
# Backup erstellen
make db-backup
# → Erstellt: backups/backup_20240128_143022.sql

# Backup wiederherstellen
make db-restore BACKUP=backup_20240128_143022.sql
```

## Fehlerbehebung

### Container startet nicht

```bash
# Logs prüfen
make logs

# Gesundheit prüfen
make health

# Komplett neu starten
make reset
```

### Port bereits belegt

```bash
# Port 3333 (App) oder 5433 (Datenbank) wird bereits verwendet
# Prozess finden:
lsof -i :3333
lsof -i :5433

# Oder in docker-compose.yml andere Ports konfigurieren (nur die linke
# Zahl ist der Host-Port, die rechte ist der Container-interne Port):
ports:
  - "3000:5000"  # App auf Port 3000 statt 3333
```

### Datenbank-Probleme

```bash
# Datenbank komplett zurücksetzen
make db-reset

# Migrationen neu ausführen
make db-migrate
```

### Speicherplatz-Probleme

```bash
# Alles bereinigen
make clean-all

# Docker System bereinigen
docker system prune -a --volumes
```

## Produktions-Deployment

```bash
# Produktions-Image bauen
make build

# Produktionsumgebung starten
make prod

# Stoppen
make prod-stop
```

**Wichtig:** Für Produktion unbedingt:
- `SESSION_SECRET` ändern
- Sichere Datenbank-Passwörter setzen
- HTTPS konfigurieren

Im Produktionsmodus (`docker-compose.prod.yml`) wird der Quellcode-Bind-Mount der Entwicklungsumgebung entfernt; gescrapte Projektdaten (`/app/data` im Container) bleiben stattdessen in einem eigenen benannten Volume (`app_data`) erhalten und überleben Neustarts/Updates des Containers.

`make prod` baut das Image vor dem Start neu, damit Änderungen übernommen werden.
Beim Start wird das Datenbankschema aktualisiert. Schlägt das fehl, bricht der
Container mit einer Fehlermeldung ab; eine erzwungene Migration erfolgt nicht.
Zur Diagnose: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=60 app`.
Zum Aktualisieren keine Volumes löschen (`down -v` oder `make clean-all` vermeiden).

## Entwicklung

`make dev` und `make start` bauen das Image und erneuern das anonyme
`node_modules`-Volume. So überdecken alte oder unvollständige Abhängigkeiten
nicht die Pakete des neuen Images. Installiere zusätzliche Pakete über
`make npm-install PKG=paketname`, damit sie auch in den Paketdateien stehen.
Das benannte PostgreSQL-Volume und die gescrapten Dateien bleiben erhalten.

### Hot Reload

Die Entwicklungsumgebung hat Hot Reload aktiviert. Änderungen am Code werden automatisch erkannt.

### NPM Pakete installieren

```bash
# Im Container
make npm-install PKG=paketname

# Oder
docker compose exec app npm install paketname
```

### Shell-Zugriff

```bash
# Normale Shell
make shell

# Root-Shell
make shell-root
```

## Umgebungsvariablen

Die wichtigsten Variablen in `docker-compose.yml`:

| Variable | Beschreibung | Standard |
|----------|--------------|----------|
| `DATABASE_URL` | PostgreSQL Verbindungs-URL | Automatisch gesetzt |
| `SESSION_SECRET` | Session-Verschlüsselung | `local-dev-...` |
| `NODE_ENV` | Umgebung | `development` |
| `PORT` | App-Port (Container-intern, siehe unten für den Host-Port) | `5000` |
| `OPENAI_API_KEY` | Optional: aktiviert KI-Funktionen (Keyword-/Entity-Extraktion, Embeddings, Metadaten-Anreicherung). Ohne Key laufen diese Schritte einfach übersprungen weiter. In der Shell setzen oder in eine `.env`-Datei neben `docker-compose.yml` schreiben, bevor `make dev`/`make start` läuft. | nicht gesetzt |

**Hinweis:** `PORT` ist der Port *innerhalb* des Containers. Von außen ist die App unter `http://localhost:3333` erreichbar (siehe Port-Mapping `3333:5000` in `docker-compose.yml`).

## Offline-Betrieb

Diese Konfiguration funktioniert komplett offline nach dem ersten Build:

1. **Erster Start (braucht Internet):**
   ```bash
   make dev
   ```

2. **Danach (offline möglich):**
   ```bash
   make start
   ```

Alle Daten werden lokal in Docker Volumes gespeichert.
