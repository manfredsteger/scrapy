import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Docker startup', () => {
  it('rewrites internal registry URLs before npm ci, preserving integrity and public URLs', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const rewrite = dockerfile.match(/sed -i '[^']+' package-lock.json/)?.[0];
    expect(rewrite).toBeDefined();
    expect(dockerfile.indexOf(rewrite!)).toBeLessThan(dockerfile.indexOf('npm ci'));
    const dir = mkdtempSync(join(tmpdir(), 'docker-lockfile-'));
    try {
      const lock = { packages: {
        a: { resolved: 'http://package-firewall.replit.local/npm/tsx/-/tsx-4.20.5.tgz', integrity: 'sha512-example' },
        b: { resolved: 'https://registry.npmjs.org/pg/-/pg-8.16.3.tgz' },
      } };
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
      const result = spawnSync('sh', ['-c', rewrite!], { cwd: dir });
      expect(result.status).toBe(0);
      const rewritten = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
      expect(rewritten.packages.a.resolved).toBe('https://registry.npmjs.org/tsx/-/tsx-4.20.5.tgz');
      expect(rewritten.packages.a.integrity).toBe(lock.packages.a.integrity);
      expect(rewritten.packages.b).toEqual(lock.packages.b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('replaces stale anonymous dependency volumes on development starts', () => {
    const makefile = readFileSync('Makefile', 'utf8');
    for (const target of ['dev', 'start']) {
      const recipe = makefile.split(`\n${target}:`)[1].split('\n\n')[0];
      expect(recipe).toContain('--build --force-recreate --renew-anon-volumes');
      expect(recipe).not.toContain('down -v');
    }
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain('npm ci --legacy-peer-deps --include=dev');
    expect(dockerfile).toContain('test -x node_modules/.bin/tsx');
    expect(dockerfile).toContain('test -x node_modules/.bin/drizzle-kit');
  });
  it.each([0, 1])('only starts the app if migration succeeds (exit %s)', code => {
    const dir = mkdtempSync(join(tmpdir(), 'docker-entrypoint-'));
    try {
      writeFileSync(join(dir, 'pg_isready'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
      const result = spawnSync('sh', ['docker/entrypoint.sh', 'echo', 'APP_STARTED'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        timeout: 5000,
      });
      expect(result.status).toBe(code);
      expect(result.stdout.includes('APP_STARTED')).toBe(code === 0);
      expect(result.stdout.includes('✅ Datenbank-Schema aktualisiert!')).toBe(code === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships migration inputs, writable runtime directories and the actual built entrypoint', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8').split('AS production')[1];
    expect(dockerfile).toContain('/app/drizzle.config.ts');
    expect(dockerfile).toContain('/app/shared ./shared');
    expect(dockerfile).toContain('chown -R mapscraper:nodejs /app/data /app/migrations');
    expect(dockerfile).toContain('CMD ["node", "dist/index.cjs"]');
    const makefile = readFileSync('Makefile', 'utf8');
    expect(makefile.split('prod:')[1].split('prod-stop:')[0]).toContain('up -d --build');
    expect(readFileSync('.dockerignore', 'utf8').split('\n')).toContain('data');
  });
});
