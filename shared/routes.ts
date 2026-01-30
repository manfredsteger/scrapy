import { z } from 'zod';
import { insertProjectSchema, sitemapUrlEntrySchema, scrapingErrorSchema, scrapingStatsSchema } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// Project response schema
const projectResponseSchema = z.object({
  id: z.number(),
  domain: z.string(),
  displayName: z.string().nullable(),
  lastScraped: z.string().nullable(),
  status: z.string(),
  queue: z.array(z.string()),
  processed: z.array(z.string()),
  results: z.array(sitemapUrlEntrySchema),
  errors: z.array(scrapingErrorSchema),
  stats: scrapingStatsSchema.nullable(),
  createdAt: z.string().nullable(),
});

export const api = {
  projects: {
    list: {
      method: 'GET' as const,
      path: '/api/projects',
      responses: {
        200: z.array(projectResponseSchema),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/projects/:id',
      responses: {
        200: projectResponseSchema,
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/projects',
      input: z.object({
        domain: z.string(),
        displayName: z.string().optional(),
        status: z.string().optional(),
        queue: z.array(z.string()).optional(),
        processed: z.array(z.string()).optional(),
        results: z.array(sitemapUrlEntrySchema).optional(),
        errors: z.array(scrapingErrorSchema).optional(),
        stats: scrapingStatsSchema.optional(),
      }),
      responses: {
        201: projectResponseSchema,
        400: errorSchemas.validation,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/projects/:id',
      input: z.object({
        domain: z.string().optional(),
        displayName: z.string().optional(),
        status: z.string().optional(),
        queue: z.array(z.string()).optional(),
        processed: z.array(z.string()).optional(),
        results: z.array(sitemapUrlEntrySchema).optional(),
        errors: z.array(scrapingErrorSchema).optional(),
        stats: scrapingStatsSchema.optional(),
      }),
      responses: {
        200: projectResponseSchema,
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/projects/:id',
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
  },
  settings: {
    get: {
      method: 'GET' as const,
      path: '/api/settings/:key',
      responses: {
        200: z.object({ key: z.string(), value: z.string() }),
        404: errorSchemas.notFound,
      },
    },
    set: {
      method: 'PUT' as const,
      path: '/api/settings/:key',
      input: z.object({ value: z.string() }),
      responses: {
        200: z.object({ key: z.string(), value: z.string() }),
      },
    },
  },
  scrape: {
    detect: {
      method: 'POST' as const,
      path: '/api/scrape/detect',
      input: z.object({ url: z.string() }),
      responses: {
        200: z.object({
          url: z.string(),
          type: z.enum(['wikijs', 'wordpress', 'generic']),
          confidence: z.number(),
          indicators: z.array(z.string()),
        }),
        400: errorSchemas.validation,
      },
    },
    discover: {
      method: 'POST' as const,
      path: '/api/scrape/discover',
      input: z.object({ domain: z.string() }),
      responses: {
        200: z.object({ sitemaps: z.array(z.string()) }),
        400: errorSchemas.validation,
      },
    },
    fetchSitemap: {
      method: 'POST' as const,
      path: '/api/scrape/sitemap',
      input: z.object({ url: z.string() }),
      responses: {
        200: z.object({ 
          urls: z.array(sitemapUrlEntrySchema), 
          subSitemaps: z.array(z.string()) 
        }),
        400: errorSchemas.validation,
      },
    },
    fetchContent: {
      method: 'POST' as const,
      path: '/api/scrape/content',
      input: z.object({ 
        urls: z.array(z.string()),
        projectId: z.number().optional(),
      }),
      responses: {
        200: z.object({
          results: z.array(z.object({
            url: z.string(),
            data: z.any().nullable(),
            error: z.string().nullable(),
            usedProxy: z.string().optional(),
          })),
          rateLimitState: z.object({
            currentDelay: z.number(),
            baseDelay: z.number(),
            maxDelay: z.number(),
            backoffMultiplier: z.number(),
            consecutiveErrors: z.number(),
            lastRequestTime: z.number().optional(),
          }).optional(),
          proxyInfo: z.object({
            enabled: z.boolean(),
            totalProxies: z.number(),
            availableProxies: z.number(),
          }).optional(),
        }),
        400: errorSchemas.validation,
      },
    },
    crawl: {
      method: 'POST' as const,
      path: '/api/scrape/crawl',
      input: z.object({ 
        urls: z.array(z.string()),
        domain: z.string(),
      }),
      responses: {
        200: z.object({
          results: z.array(z.object({
            url: z.string(),
            links: z.array(z.string()),
            data: z.any().nullable(),
            error: z.string().nullable(),
          })),
        }),
        400: errorSchemas.validation,
      },
    },
  },
  export: {
    csv: {
      method: 'GET' as const,
      path: '/api/projects/:id/export/csv',
      responses: {
        200: z.string(),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
      },
    },
    parquet: {
      method: 'GET' as const,
      path: '/api/projects/:id/export/parquet',
      responses: {
        200: z.any(),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
      },
    },
    incremental: {
      method: 'GET' as const,
      path: '/api/projects/:id/export/incremental',
      responses: {
        200: z.object({
          newChunks: z.array(z.any()),
          updatedChunks: z.array(z.any()),
          deletedChunkIds: z.array(z.string()),
          exportedAt: z.string(),
          stats: z.object({
            totalNew: z.number(),
            totalUpdated: z.number(),
            totalDeleted: z.number(),
          }),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

const incrementalUpdateResponseSchema = z.object({
  newChunks: z.array(z.any()),
  updatedChunks: z.array(z.any()),
  deletedChunkIds: z.array(z.string()),
  exportedAt: z.string(),
  stats: z.object({
    totalNew: z.number(),
    totalUpdated: z.number(),
    totalDeleted: z.number(),
  }),
});

export type IncrementalUpdateResponse = z.infer<typeof incrementalUpdateResponseSchema>;
