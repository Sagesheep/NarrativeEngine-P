// Bundles server.js + all its dependencies into a single server.bundle.cjs
// so that electron-builder can unpack it from the ASAR and Node can load it
// without needing access to node_modules inside the ASAR.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'server.bundle.cjs',
  external: [
    'better-sqlite3',
    'sqlite-vec',
    '@huggingface/transformers',
    'onnxruntime-node',
  ],
  // Inject a proper import.meta.url shim so fileURLToPath(import.meta.url)
  // resolves correctly inside the CJS bundle
  define: {
    'import.meta.url': '__importMetaUrl',
  },
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
});

console.log('server.bundle.cjs built successfully');
