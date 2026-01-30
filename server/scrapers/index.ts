import { BaseScraper, ScraperOptions, ScraperResult, WebsiteType, WebsiteDetectionResult } from "./base-scraper";
import { WikiJsScraper } from "./wikijs-scraper";
import { WordPressScraper } from "./wordpress-scraper";
import { GenericScraper } from "./generic-scraper";
import { detectWebsiteType } from "../utils/detector";

export { BaseScraper, ScraperResult, WebsiteType, WebsiteDetectionResult } from "./base-scraper";
export { WikiJsScraper } from "./wikijs-scraper";
export { WordPressScraper } from "./wordpress-scraper";
export { GenericScraper } from "./generic-scraper";
export { detectWebsiteType } from "../utils/detector";

export interface ScraperRegistry {
  [key: string]: new (baseUrl: string, options?: ScraperOptions) => BaseScraper;
}

const scraperRegistry: ScraperRegistry = {
  wikijs: WikiJsScraper,
  wordpress: WordPressScraper,
  generic: GenericScraper,
};

export function createScraper(
  type: WebsiteType, 
  baseUrl: string, 
  options?: ScraperOptions
): BaseScraper {
  const ScraperClass = scraperRegistry[type] || GenericScraper;
  return new ScraperClass(baseUrl, options);
}

export async function createScraperWithAutoDetect(
  url: string, 
  options?: ScraperOptions
): Promise<{ scraper: BaseScraper; detection: WebsiteDetectionResult }> {
  const detection = await detectWebsiteType(url);
  const scraper = createScraper(detection.type, url, options);
  return { scraper, detection };
}

export function registerScraper(
  type: string, 
  scraperClass: new (baseUrl: string, options?: ScraperOptions) => BaseScraper
): void {
  scraperRegistry[type] = scraperClass;
}

export function getAvailableScraperTypes(): string[] {
  return Object.keys(scraperRegistry);
}
