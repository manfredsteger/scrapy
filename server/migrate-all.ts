import { pool, db } from "./db";
import { projects, singlePages } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as fileStorage from "./fileStorage";
import { orderedElementsToMarkdown } from "./markdownConverter";

async function migrateProjects() {
  const allProjects = await db.select().from(projects);
  console.log(`\n=== Migrating ${allProjects.length} projects ===\n`);

  for (const project of allProjects) {
    const results = (project.results || []) as any[];
    const withData = results.filter((r: any) => r.scrapedData);
    console.log(`Project #${project.id} "${project.displayName}" (${project.domain}): ${withData.length} pages with data`);

    const projDir = fileStorage.getProjectDir(project.id, project.domain);
    await fileStorage.saveProjectMeta(projDir, {
      id: project.id,
      domain: project.domain,
      displayName: project.displayName,
      createdAt: project.createdAt,
      projectSettings: project.projectSettings,
    });

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const result of withData) {
      const url = result.loc;
      const data = result.scrapedData;

      try {
        const pageDir = fileStorage.getProjectPageDir(project.id, project.domain, url);

        const existing = await fileStorage.readPageContent(pageDir);
        if (existing) {
          skipped++;
          migrated++;
          continue;
        }

        const markdown = orderedElementsToMarkdown(data.orderedElements || []);
        await fileStorage.savePageContent(pageDir, markdown);
        await fileStorage.savePageMeta(pageDir, {
          url,
          title: data.title,
          timestamp: data.timestamp,
          wordCount: data.wordCount,
          structuredData: data.structuredData,
          linkedPdfs: data.linkedPdfs,
          orderedElements: data.orderedElements,
        });

        migrated++;
        if (migrated % 100 === 0) {
          console.log(`  ...${migrated}/${withData.length} migrated`);
        }
      } catch (err) {
        errors++;
        migrated++;
        console.error(`  Error migrating ${url}: ${(err as Error).message}`);
      }
    }

    console.log(`  Done: ${migrated - skipped} migrated, ${skipped} skipped, ${errors} errors\n`);
  }
}

async function migrateSinglePages() {
  const allSinglePages = await db.select().from(singlePages);
  const withData = allSinglePages.filter((sp) => sp.scrapedData);
  console.log(`\n=== Migrating ${withData.length} single pages ===\n`);

  for (const sp of withData) {
    try {
      const pageDir = fileStorage.getSinglePageDir(sp.id, sp.domain);

      const existing = await fileStorage.readPageContent(pageDir);
      if (existing) {
        console.log(`  Skipped single page #${sp.id} (exists): ${sp.url}`);
        continue;
      }

      const data = sp.scrapedData as any;
      const markdown = orderedElementsToMarkdown(data.orderedElements || []);
      await fileStorage.savePageContent(pageDir, markdown);
      await fileStorage.savePageMeta(pageDir, {
        url: sp.url,
        title: data.title || sp.title,
        timestamp: data.timestamp,
        wordCount: sp.wordCount,
        structuredData: sp.structuredData,
        linkedPdfs: data.linkedPdfs,
        orderedElements: data.orderedElements,
      });
      console.log(`  Migrated single page #${sp.id}: ${sp.url}`);
    } catch (err) {
      console.error(`  Error migrating single page #${sp.id}: ${(err as Error).message}`);
    }
  }
}

async function cleanDatabase() {
  console.log(`\n=== Cleaning database (removing scrapedData from results) ===\n`);

  const allProjects = await db.select().from(projects);

  for (const project of allProjects) {
    const results = (project.results || []) as any[];
    const cleanedResults = results.map((r: any) => {
      const { scrapedData, ...rest } = r;
      return rest;
    });

    await db.update(projects).set({
      results: cleanedResults,
    }).where(eq(projects.id, project.id));

    console.log(`  Project #${project.id}: cleared scrapedData from ${results.length} results`);
  }

  for (const sp of await db.select().from(singlePages)) {
    if (sp.scrapedData) {
      await db.update(singlePages).set({
        scrapedData: null,
      }).where(eq(singlePages.id, sp.id));
      console.log(`  Single page #${sp.id}: cleared scrapedData`);
    }
  }

  console.log(`\nDatabase cleaned.`);
}

async function main() {
  try {
    console.log("Starting full migration to filesystem...\n");
    await migrateProjects();
    await migrateSinglePages();

    const stats = await fileStorage.getStorageStats();
    console.log(`\nFilesystem stats: ${stats.totalFiles} files, ${(stats.totalSizeBytes / 1024 / 1024).toFixed(1)} MB`);

    await cleanDatabase();

    console.log("\n=== Migration complete! ===\n");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

main();
