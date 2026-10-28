#!/bin/sh
# MapScraper Pro - Docker Entrypoint
# Runs database migrations before starting the application

set -e

echo "🚀 MapScraper Pro startet..."

# Wait for database to be ready
echo "⏳ Warte auf Datenbank..."
until pg_isready -h db -p 5432 -U mapscraper -q 2>/dev/null; do
  sleep 1
done
echo "✅ Datenbank ist bereit!"

# Run database migrations
echo "📦 Führe Datenbank-Migrationen aus..."
if ! npm run db:push; then
  echo "❌ Datenbank-Migration fehlgeschlagen. Start abgebrochen; keine erzwungene Migration."
  exit 1
fi
echo "✅ Datenbank-Schema aktualisiert!"

# Start the application
echo "🌐 Starte Anwendung..."
exec "$@"
