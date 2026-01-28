-- MapScraper Pro - Database Initialization
-- This script runs automatically when the PostgreSQL container starts for the first time.

-- Create extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE mapscraper TO mapscraper;

-- Note: Tables are created automatically by Drizzle ORM on first run
-- via the db:push command. This file is for any additional setup.
