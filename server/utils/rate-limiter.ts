import type { ProjectSettings, RateLimitState } from "@shared/schema";

// Rate Limiter class for managing request delays with auto-adjustment
export class RateLimiter {
  private currentDelay: number;
  private baseDelay: number;
  private maxDelay: number;
  private backoffMultiplier: number;
  private consecutiveErrors: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastRequestTime: number = 0;
  private enabled: boolean;

  constructor(settings: ProjectSettings['scraping']['rateLimiting']) {
    this.enabled = settings.enabled;
    this.baseDelay = settings.baseDelayMs;
    this.maxDelay = settings.maxDelayMs;
    this.backoffMultiplier = settings.backoffMultiplier;
    this.currentDelay = settings.baseDelayMs;
  }

  // Reserves the next free request slot *before* waiting. Callers started in
  // parallel (Promise.all over a batch) therefore get slots spaced by
  // currentDelay instead of all seeing the same lastRequestTime and firing
  // at once - which some servers answer by silently dropping the client IP.
  async waitBeforeRequest(): Promise<void> {
    if (!this.enabled) return;

    const now = Date.now();
    const slot = Math.max(now, this.lastRequestTime + this.currentDelay);
    this.lastRequestTime = slot;

    const waitTime = slot - now;
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  onSuccess(): void {
    if (!this.enabled) return;
    
    this.consecutiveErrors = 0;
    this.consecutiveSuccesses++;
    
    // Gradually decrease delay after 3 consecutive successes
    if (this.consecutiveSuccesses >= 3 && this.currentDelay > this.baseDelay) {
      const newDelay = Math.max(this.baseDelay, this.currentDelay / this.backoffMultiplier);
      if (newDelay !== this.currentDelay) {
        console.log(`[RateLimiter] Decreasing delay: ${this.currentDelay}ms -> ${newDelay}ms (${this.consecutiveSuccesses} consecutive successes)`);
        this.currentDelay = newDelay;
        this.consecutiveSuccesses = 0;
      }
    }
  }

  onRateLimit(): void {
    if (!this.enabled) return;
    
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors++;
    
    const newDelay = Math.min(this.maxDelay, this.currentDelay * this.backoffMultiplier);
    console.log(`[RateLimiter] Rate limit hit (429). Increasing delay: ${this.currentDelay}ms -> ${newDelay}ms`);
    this.currentDelay = newDelay;
  }

  onError(): void {
    if (!this.enabled) return;
    
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors++;
    
    // Only increase delay if we get multiple consecutive errors
    if (this.consecutiveErrors >= 2) {
      const newDelay = Math.min(this.maxDelay, this.currentDelay * 1.5);
      console.log(`[RateLimiter] Multiple errors (${this.consecutiveErrors}). Adjusting delay: ${this.currentDelay}ms -> ${newDelay}ms`);
      this.currentDelay = newDelay;
    }
  }

  getState(): RateLimitState {
    return {
      currentDelay: this.currentDelay,
      baseDelay: this.baseDelay,
      maxDelay: this.maxDelay,
      backoffMultiplier: this.backoffMultiplier,
      consecutiveErrors: this.consecutiveErrors,
      lastRequestTime: this.lastRequestTime,
    };
  }

  getCurrentDelay(): number {
    return this.currentDelay;
  }

  // Returns true when the server has significantly pushed back — either via
  // explicit 429s or repeated fetch errors causing the delay to at least
  // double from baseline.
  // Returns true when the batch produced significant throttling signals.
  // Works even when automatic delay adjustment is disabled — a 429 is always
  // a rate-limit regardless of whether the user wants auto-backoff.
  isRateLimited(): boolean {
    return this.consecutiveErrors >= 2 || this.currentDelay >= this.baseDelay * 2;
  }
}
