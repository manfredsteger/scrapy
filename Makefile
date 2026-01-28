# ============================================================================
# MapScraper Pro - Development Makefile
# ============================================================================
# Plattform-unabhängig: Funktioniert auf x86_64, ARM64 (Apple Silicon, RPi4+)
# Betriebssysteme: Linux, macOS, Windows (mit WSL2)
# ============================================================================

.PHONY: help install dev start stop restart logs clean reset db-reset db-shell build prod shell test

# Default target
.DEFAULT_GOAL := help

# Colors for output
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RED := \033[31m
RESET := \033[0m

# ============================================================================
# HILFE
# ============================================================================

help: ## Zeigt diese Hilfe an
	@echo ""
	@echo "$(CYAN)╔══════════════════════════════════════════════════════════════╗$(RESET)"
	@echo "$(CYAN)║          MapScraper Pro - Entwicklungsumgebung               ║$(RESET)"
	@echo "$(CYAN)╚══════════════════════════════════════════════════════════════╝$(RESET)"
	@echo ""
	@echo "$(GREEN)Verfügbare Befehle:$(RESET)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-15s$(RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)Beispiele:$(RESET)"
	@echo "  make dev        - Startet die Entwicklungsumgebung"
	@echo "  make logs       - Zeigt Live-Logs an"
	@echo "  make reset      - Kompletter Neustart (Datenbank + Container)"
	@echo ""

# ============================================================================
# ENTWICKLUNG
# ============================================================================

install: ## Installiert Abhängigkeiten lokal (ohne Docker)
	@echo "$(CYAN)► Installiere Node.js Abhängigkeiten...$(RESET)"
	npm ci --legacy-peer-deps

dev: ## Startet Entwicklungsumgebung (Docker Compose)
	@echo "$(CYAN)► Starte MapScraper Pro Entwicklungsumgebung...$(RESET)"
	docker compose up --build

start: ## Startet Container im Hintergrund
	@echo "$(CYAN)► Starte Container im Hintergrund...$(RESET)"
	docker compose up -d --build
	@echo "$(GREEN)✓ MapScraper Pro läuft auf http://localhost:5000$(RESET)"

stop: ## Stoppt alle Container
	@echo "$(YELLOW)► Stoppe Container...$(RESET)"
	docker compose down

restart: stop start ## Neustart aller Container
	@echo "$(GREEN)✓ Neustart abgeschlossen$(RESET)"

logs: ## Zeigt Live-Logs an (Strg+C zum Beenden)
	docker compose logs -f

logs-app: ## Zeigt nur App-Logs an
	docker compose logs -f app

logs-db: ## Zeigt nur Datenbank-Logs an
	docker compose logs -f db

# ============================================================================
# DATENBANK
# ============================================================================

db-reset: ## Setzt Datenbank zurück (löscht alle Daten!)
	@echo "$(RED)⚠ WARNUNG: Alle Datenbankdaten werden gelöscht!$(RESET)"
	@read -p "Fortfahren? [j/N] " confirm && [ "$$confirm" = "j" ] || exit 1
	@echo "$(YELLOW)► Lösche Datenbank-Volume...$(RESET)"
	docker compose down -v
	@echo "$(GREEN)✓ Datenbank zurückgesetzt$(RESET)"

db-shell: ## Öffnet PostgreSQL Shell
	@echo "$(CYAN)► Öffne PostgreSQL Shell...$(RESET)"
	docker compose exec db psql -U mapscraper -d mapscraper

db-backup: ## Erstellt Datenbank-Backup
	@echo "$(CYAN)► Erstelle Backup...$(RESET)"
	@mkdir -p backups
	docker compose exec db pg_dump -U mapscraper mapscraper > backups/backup_$$(date +%Y%m%d_%H%M%S).sql
	@echo "$(GREEN)✓ Backup erstellt in ./backups/$(RESET)"

db-restore: ## Stellt Datenbank aus Backup wieder her (BACKUP=dateiname.sql)
	@if [ -z "$(BACKUP)" ]; then echo "$(RED)Fehler: BACKUP=dateiname.sql angeben$(RESET)"; exit 1; fi
	@echo "$(YELLOW)► Stelle Backup wieder her: $(BACKUP)$(RESET)"
	cat backups/$(BACKUP) | docker compose exec -T db psql -U mapscraper -d mapscraper
	@echo "$(GREEN)✓ Backup wiederhergestellt$(RESET)"

db-migrate: ## Führt Datenbankmigrationen aus
	@echo "$(CYAN)► Führe Migrationen aus...$(RESET)"
	docker compose exec app npm run db:push

# ============================================================================
# BEREINIGUNG
# ============================================================================

clean: ## Stoppt Container und löscht Images
	@echo "$(YELLOW)► Bereinige Docker-Ressourcen...$(RESET)"
	docker compose down --rmi local
	@echo "$(GREEN)✓ Bereinigung abgeschlossen$(RESET)"

clean-all: ## Löscht ALLES (Container, Images, Volumes, Cache)
	@echo "$(RED)⚠ WARNUNG: Alle Daten werden unwiderruflich gelöscht!$(RESET)"
	@read -p "Fortfahren? [j/N] " confirm && [ "$$confirm" = "j" ] || exit 1
	@echo "$(YELLOW)► Lösche alle Docker-Ressourcen...$(RESET)"
	docker compose down -v --rmi all --remove-orphans
	docker system prune -f
	rm -rf node_modules
	@echo "$(GREEN)✓ Alles gelöscht$(RESET)"

reset: clean-all dev ## Kompletter Reset und Neustart

# ============================================================================
# PRODUKTION
# ============================================================================

build: ## Baut Produktions-Image
	@echo "$(CYAN)► Baue Produktions-Image...$(RESET)"
	docker compose -f docker-compose.yml -f docker-compose.prod.yml build

prod: ## Startet Produktionsumgebung
	@echo "$(CYAN)► Starte Produktionsumgebung...$(RESET)"
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
	@echo "$(GREEN)✓ Produktion läuft auf http://localhost:5000$(RESET)"

prod-stop: ## Stoppt Produktionsumgebung
	docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# ============================================================================
# MULTI-ARCHITEKTUR (ARM/x86)
# ============================================================================

build-multi: ## Baut Images für ARM64 und AMD64
	@echo "$(CYAN)► Baue Multi-Architektur Images...$(RESET)"
	docker buildx create --name multiarch --driver docker-container --use 2>/dev/null || true
	docker buildx build --platform linux/amd64,linux/arm64 -t mapscraper-pro:latest .
	@echo "$(GREEN)✓ Multi-Arch Build abgeschlossen$(RESET)"

# ============================================================================
# ENTWICKLER-TOOLS
# ============================================================================

shell: ## Öffnet Shell im App-Container
	docker compose exec app sh

shell-root: ## Öffnet Root-Shell im App-Container
	docker compose exec -u root app sh

npm-install: ## Installiert npm Paket im Container (PKG=paketname)
	@if [ -z "$(PKG)" ]; then echo "$(RED)Fehler: PKG=paketname angeben$(RESET)"; exit 1; fi
	docker compose exec app npm install $(PKG)

status: ## Zeigt Container-Status an
	@echo "$(CYAN)Container Status:$(RESET)"
	@docker compose ps
	@echo ""
	@echo "$(CYAN)Ressourcenverbrauch:$(RESET)"
	@docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null || true

health: ## Prüft Gesundheit aller Services
	@echo "$(CYAN)► Prüfe Service-Gesundheit...$(RESET)"
	@docker compose ps --format "table {{.Name}}\t{{.Status}}"
	@echo ""
	@echo "$(CYAN)► Teste Datenbank-Verbindung...$(RESET)"
	@docker compose exec db pg_isready -U mapscraper && echo "$(GREEN)✓ Datenbank OK$(RESET)" || echo "$(RED)✗ Datenbank nicht erreichbar$(RESET)"
	@echo ""
	@echo "$(CYAN)► Teste App-Endpunkt...$(RESET)"
	@curl -s -o /dev/null -w "%{http_code}" http://localhost:5000 | grep -q "200" && echo "$(GREEN)✓ App OK (HTTP 200)$(RESET)" || echo "$(YELLOW)! App antwortet nicht mit 200$(RESET)"
