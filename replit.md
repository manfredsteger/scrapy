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
- **Database**: PostgreSQL, managed with Drizzle ORM.
- **Schema Management**: Drizzle ORM defines database schemas in `shared/schema.ts`, with migrations handled by Drizzle Kit.
- **Access Pattern**: Repository pattern implemented in `server/storage.ts` for data access.

### RAG Pack Generation
- **Chunking System**: Token-based chunking using `gpt-tokenizer`, configurable target/overlap tokens, sentence-based overlap, preservation of heading hierarchy, tables, and code blocks. Includes SHA256 hashing for integrity and quality checks.
- **Deduplication**: Exact and near-duplicate detection using SHA256 and Jaccard similarity.
- **AI Enrichment**: Integration with OpenAI (requires `OPENAI_API_KEY`) for embeddings generation, keyword extraction, summary generation, category recognition, and named entity extraction.
- **Export Format**: RAG Packs are exported as ZIP archives containing `manifest.json`, `documents.jsonl`, `chunks.jsonl`, and JSON schemas for validation.

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