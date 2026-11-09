# texture2ddecoder-wasm Examples

Working setups for decoding textures with `texture2ddecoder-wasm`: plain Node.js, a no-build
browser page, and several bundlers and frameworks. Pick the one closest to your project, copy it
and adapt it.

## Available Examples

### Node.js Examples

#### Pure Node.js (CommonJS)

- **Directory:** `nodejs-commonjs-example/`
- **Files:**
  - `index.js` - Pure Node.js example using `require()`
  - `package.json` - CommonJS configuration
- **Good for:** traditional Node.js projects, backend services

**Try it:**

```bash
cd examples/nodejs-commonjs-example
npm install
npm start
```

It initializes the WASM automatically and shows BC1/BC3 decoding with file I/O.

#### Node.js ESM

- **Directory:** `nodejs-esm-example/`
- **Files:**
  - `index.mjs` - Modern Node.js example using `import/export`
  - `package.json` - ESM configuration with `"type": "module"`
- **Good for:** modern Node.js projects, TypeScript projects

**Try it:**

```bash
cd examples/nodejs-esm-example
npm install
npm start
```

It shows BC1, BC3, ETC2 and ASTC decoding with ES module syntax.

### Browser Examples

#### Vite + CDN (Recommended)

- **Directory:** `vite-cdn-example/`
- **Files:**
  - `index.html` - Main HTML file
  - `src/main.js` - Application logic with CDN imports
  - `vite.config.js` - Vite configuration
  - `public/compressed_etc2_rgba_400x400.bin` - Real ETC2 RGBA texture (400x400)
- **Good for:** modern development with fast hot reload (HMR) and the CDN

**Try it:**

```bash
cd examples/vite-cdn-example
npm install
npm run dev
```

It shows the Vite dev server, CDN loading, decoding a real texture onto a canvas, and a
production build.

#### CDN Usage (No Build Required!)

- **File:** `cdn-example.html`
- **Zero setup:** no `npm install`
- **Good for:** quick prototypes, minimal setup

**Try it:**

```bash
# Serve with HTTP server (required for file loading)
cd examples
python -m http.server 8000

# Then visit: http://localhost:8000/cdn-example.html
```

**Important:** Serve it over HTTP, not `file://`. Otherwise the browser blocks loading the
texture file (CORS error).

It loads the library from the jsDelivr CDN, with no installation or build tools.

#### Vite + React

- **Directory:** `vite-react-example/`
- **Files:**
  - `vite.config.js` - Simple Vite configuration
  - `src/App.jsx` - React component example using CDN

**Setup:**

```bash
npm install vite @vitejs/plugin-react
npm install texture2ddecoder-wasm
```

**Note:** This example uses the CDN, so you do not need to copy WASM files.

#### Next.js (App Router)

- **Directory:** `nextjs-example/`
- **Files:**
  - `next.config.js` - Next.js configuration
  - `app/texture-viewer/page.tsx` - Client component example using CDN

**Setup:**

```bash
npm install texture2ddecoder-wasm
```

**Note:** This example uses the CDN, so you do not need to copy WASM files.

## Usage Instructions

### CDN Approach (Recommended for Development)

All examples use the CDN by default, so you do not need to copy any WASM files.

1. **Install the package** via npm

   ```bash
   npm install texture2ddecoder-wasm
   ```

2. **Initialize with CDN:**

   ```typescript
   import { initialize } from "texture2ddecoder-wasm";

   await initialize({
     wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
   });
   ```

3. **Use decode functions** after initialization

### Local Files Approach (For Production)

If you prefer to serve WASM files locally:

1. **Install the package** via npm
2. **Copy WASM files** to your public directory:
   ```bash
   npx texture2ddecoder-copy-wasm public/wasm
   ```
3. **Initialize with local path:**

   ```typescript
   import { initialize } from "texture2ddecoder-wasm";

   await initialize({ wasmPath: "/wasm" });
   ```

## General Pattern

**CDN benefits:**

- No file copying
- Fastest setup
- Cached globally by the CDN
- Good for development and prototyping

**Local files benefits:**

- Faster loading (same domain)
- Works offline
- No external dependencies
- Better for production

## Additional Resources

- [Complete Bundler Guide](../BUNDLER_GUIDE.md) - Comprehensive setup for all bundlers
- [Main README](../README.md) - API documentation and usage guide
- [npm package](https://www.npmjs.com/package/texture2ddecoder-wasm)

## Contributing Examples

Have a working configuration for another bundler? Send a PR.

Examples we would like to have:

- Webpack 5
- Create React App
- SvelteKit
- Angular
- Remix
- Astro
- Nuxt 3
- Deno
- Bun
