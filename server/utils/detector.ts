import { JSDOM } from "jsdom";
import type { WebsiteType, WebsiteDetectionResult } from "../scrapers/base-scraper";

export async function detectWebsiteType(url: string): Promise<WebsiteDetectionResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MapScraperPro/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { type: 'generic', confidence: 0.5, indicators: ['HTTP error, falling back to generic'] };
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Check Moodle first (it's very distinctive)
    const moodleResult = detectMoodle(doc, html);
    if (moodleResult.confidence >= 0.7) {
      return moodleResult;
    }

    const wikijsResult = detectWikiJs(doc, html);
    if (wikijsResult.confidence >= 0.7) {
      return wikijsResult;
    }

    const wordpressResult = detectWordPress(doc, html);
    if (wordpressResult.confidence >= 0.7) {
      return wordpressResult;
    }

    // Check medium confidence results
    if (moodleResult.confidence >= 0.5) {
      return moodleResult;
    }

    if (wikijsResult.confidence > wordpressResult.confidence && wikijsResult.confidence >= 0.4) {
      return wikijsResult;
    }
    if (wordpressResult.confidence > wikijsResult.confidence && wordpressResult.confidence >= 0.4) {
      return wordpressResult;
    }

    return { type: 'generic', confidence: 1.0, indicators: ['No specific CMS detected'] };
  } catch (error) {
    return { 
      type: 'generic', 
      confidence: 0.5, 
      indicators: [`Detection error: ${(error as Error).message}`] 
    };
  }
}

function detectWikiJs(doc: Document, html: string): WebsiteDetectionResult {
  const indicators: string[] = [];
  let confidence = 0;

  const generatorMeta = doc.querySelector('meta[name="generator"]');
  const generatorContent = generatorMeta?.getAttribute('content')?.toLowerCase() || '';
  if (generatorContent.includes('wiki.js')) {
    indicators.push('Generator meta tag: Wiki.js');
    confidence += 0.5;
  }

  const rootDiv = doc.querySelector('div#root');
  if (rootDiv) {
    indicators.push('React root element (#root)');
    confidence += 0.1;
  }

  if (html.toLowerCase().includes('wiki.js')) {
    indicators.push('Wiki.js mention in HTML');
    confidence += 0.2;
  }

  if (html.includes('/graphql') || html.includes('graphql')) {
    indicators.push('GraphQL endpoint detected');
    confidence += 0.15;
  }

  const contentsDiv = doc.querySelector('div.contents');
  if (contentsDiv) {
    indicators.push('Wiki.js content container (.contents)');
    confidence += 0.2;
  }

  if (doc.querySelector('.v-application') || doc.querySelector('[data-app="true"]')) {
    indicators.push('Vue/Vuetify application detected');
    confidence += 0.1;
  }

  if (html.includes('/_assets/') && html.includes('.js')) {
    indicators.push('Wiki.js asset pattern');
    confidence += 0.1;
  }

  return {
    type: 'wikijs',
    confidence: Math.min(confidence, 1.0),
    indicators,
  };
}

function detectMoodle(doc: Document, html: string): WebsiteDetectionResult {
  const indicators: string[] = [];
  let confidence = 0;

  // Check for Moodle-specific config object
  if (html.includes('M.cfg') && html.includes('sesskey')) {
    indicators.push('Moodle JavaScript config (M.cfg)');
    confidence += 0.4;
  }

  // Check for Moodle in meta generator
  const generatorMeta = doc.querySelector('meta[name="generator"]');
  const generatorContent = generatorMeta?.getAttribute('content')?.toLowerCase() || '';
  if (generatorContent.includes('moodle')) {
    indicators.push('Generator meta tag: Moodle');
    confidence += 0.5;
  }

  // Check for Moodle keywords in HTML
  if (html.toLowerCase().includes('moodle')) {
    indicators.push('Moodle mention in HTML');
    confidence += 0.2;
  }

  // Moodle-specific paths
  if (html.includes('/course/view.php') || html.includes('/mod/')) {
    indicators.push('Moodle course/module paths');
    confidence += 0.3;
  }

  // Moodle theme paths
  if (html.includes('/theme/') && (html.includes('/snap/') || html.includes('/boost/'))) {
    indicators.push('Moodle theme detected');
    confidence += 0.2;
  }

  // Moodle login page
  if (html.includes('/login/index.php')) {
    indicators.push('Moodle login page link');
    confidence += 0.1;
  }

  // Check for MoodleSession cookie reference
  if (html.includes('MoodleSession')) {
    indicators.push('MoodleSession reference');
    confidence += 0.2;
  }

  // Moodle-specific body classes
  const bodyClasses = doc.body?.className || '';
  if (bodyClasses.includes('format-') || bodyClasses.includes('course-')) {
    indicators.push('Moodle body classes');
    confidence += 0.15;
  }

  // Moodle mobile app link
  if (html.includes('download.moodle.org/mobile')) {
    indicators.push('Moodle mobile app link');
    confidence += 0.3;
  }

  return {
    type: 'moodle',
    confidence: Math.min(confidence, 1.0),
    indicators,
  };
}

function detectWordPress(doc: Document, html: string): WebsiteDetectionResult {
  const indicators: string[] = [];
  let confidence = 0;

  const generatorMeta = doc.querySelector('meta[name="generator"]');
  const generatorContent = generatorMeta?.getAttribute('content')?.toLowerCase() || '';
  if (generatorContent.includes('wordpress')) {
    indicators.push('Generator meta tag: WordPress');
    confidence += 0.5;
  }

  if (html.includes('/wp-content/') || html.includes('/wp-includes/')) {
    indicators.push('WordPress content paths detected');
    confidence += 0.3;
  }

  if (html.includes('wp-json') || html.includes('/wp-json/')) {
    indicators.push('WordPress REST API detected');
    confidence += 0.2;
  }

  if (doc.body?.classList.contains('wp-custom-logo') || 
      doc.body?.className.includes('wordpress')) {
    indicators.push('WordPress body classes');
    confidence += 0.2;
  }

  if (doc.querySelector('.wp-block-') || html.includes('wp-block-')) {
    indicators.push('WordPress Gutenberg blocks');
    confidence += 0.2;
  }

  if (doc.querySelector('.elementor') || html.includes('elementor')) {
    indicators.push('Elementor page builder detected');
    confidence += 0.15;
  }

  const wpAdminLink = doc.querySelector('link[href*="wp-admin"]');
  if (wpAdminLink) {
    indicators.push('WordPress admin stylesheet');
    confidence += 0.2;
  }

  return {
    type: 'wordpress',
    confidence: Math.min(confidence, 1.0),
    indicators,
  };
}

export async function detectFromUrl(url: string): Promise<{
  url: string;
  detection: WebsiteDetectionResult;
}> {
  const detection = await detectWebsiteType(url);
  return { url, detection };
}
