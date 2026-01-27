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