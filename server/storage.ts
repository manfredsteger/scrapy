import { db } from "./db";
import { projects, settings, singlePages, type Project, type InsertProject, type Settings, type InsertSettings, type SinglePage, type InsertSinglePage } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  getSetting(key: string): Promise<Settings | undefined>;
  setSetting(key: string, value: string): Promise<Settings>;
  getSinglePages(): Promise<SinglePage[]>;
  getSinglePage(id: number): Promise<SinglePage | undefined>;
  createSinglePage(data: InsertSinglePage): Promise<SinglePage>;
  updateSinglePage(id: number, data: Partial<SinglePage>): Promise<SinglePage | undefined>;
  deleteSinglePage(id: number): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  async getProjects(): Promise<Project[]> {
    return await db.select().from(projects).orderBy(desc(projects.lastScraped));
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async createProject(insertProject: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values({
      ...insertProject,
      lastScraped: new Date(),
    }).returning();
    return project;
  }

  async updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined> {
    const [project] = await db.update(projects)
      .set({ ...updates, lastScraped: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return project;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async getSetting(key: string): Promise<Settings | undefined> {
    const [setting] = await db.select().from(settings).where(eq(settings.key, key));
    return setting;
  }

  async setSetting(key: string, value: string): Promise<Settings> {
    const existing = await this.getSetting(key);
    if (existing) {
      const [updated] = await db.update(settings)
        .set({ value })
        .where(eq(settings.key, key))
        .returning();
      return updated;
    }
    const [created] = await db.insert(settings).values({ key, value }).returning();
    return created;
  }

  async getSinglePages(): Promise<SinglePage[]> {
    return await db.select().from(singlePages).orderBy(desc(singlePages.createdAt));
  }

  async getSinglePage(id: number): Promise<SinglePage | undefined> {
    const [singlePage] = await db.select().from(singlePages).where(eq(singlePages.id, id));
    return singlePage;
  }

  async createSinglePage(data: InsertSinglePage): Promise<SinglePage> {
    const [singlePage] = await db.insert(singlePages).values(data).returning();
    return singlePage;
  }

  async updateSinglePage(id: number, data: Partial<SinglePage>): Promise<SinglePage | undefined> {
    const [singlePage] = await db.update(singlePages)
      .set(data)
      .where(eq(singlePages.id, id))
      .returning();
    return singlePage;
  }

  async deleteSinglePage(id: number): Promise<boolean> {
    const result = await db.delete(singlePages).where(eq(singlePages.id, id));
    return true;
  }
}

export const storage = new DatabaseStorage();
