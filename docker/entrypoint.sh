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
npm run db:push || {
  echo "⚠️ Migrationen fehlgeschlagen, versuche mit --force..."
  npm run db:push --force || echo "❌ Migrationen konnten nicht ausgeführt werden"
}
echo "✅ Datenbank-Schema aktualisiert!"

# Start the application
echo "🌐 Starte Anwendung..."
exec "$@"
