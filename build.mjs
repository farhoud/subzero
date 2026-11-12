// Bundles each entry into one file under dist/, so the plugin runs with no install step.
// The version in package.json is stamped into each bundle as __SUBZERO_VERSION__.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const entries = {
  server: 'src/mcp/main.ts',
  hook: 'src/mcp/session-hook.ts',
  'agent-hook': 'src/routing/agent-hook.ts',
  cli: 'src/cli/main.ts',
  'pi-extension': 'src/pi-parent/main.ts',
};

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    ...(name === 'pi-extension' ? { external: ['@earendil-works/*', 'typebox'] } : {}),
    define: { __SUBZERO_VERSION__: JSON.stringify(version) },
    banner: {
      js: [
        name === 'cli' ? '#!/usr/bin/env node' : '',
        "import { createRequire as __subzeroCreateRequire } from 'node:module';",
        'const require = __subzeroCreateRequire(import.meta.url);',
      ].filter(Boolean).join('\n'),
    },
    logLevel: 'warning',
  });
}
