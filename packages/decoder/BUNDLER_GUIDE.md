# Bundler Configuration Guide

This guide shows how to use `texture2ddecoder-wasm` with each common bundler and framework. Every
setup follows the same three steps: install the package, copy its WASM files where your app can
fetch them, and call `initialize()` with the path. Each section below is a short checklist plus the
config you need.

## Pick your setup

| You use | Go to |
| --- | --- |
| No bundler (plain HTML, CodePen, a demo) | [CDN Usage](#cdn-usage-no-bundler) |
| Node.js | [General Principles](#general-principles) (no path needed) |
| Vite (plain, React or Vue) | [Vite](#vite) |
| Webpack 5 | [Webpack 5](#webpack-5) |
| Next.js (App Router or Pages Router) | [Next.js](#nextjs) |
| Create React App | [Create React App](#create-react-app-cra) |
| Rollup | [Rollup](#rollup) |
| Parcel | [Parcel](#parcel) |
| esbuild | [esbuild](#esbuild) |
| SvelteKit | [SvelteKit](#sveltekit) |
| Angular | [Angular](#angular) |
| Astro | [Astro](#astro) |
| Nuxt 3 | [Nuxt 3](#nuxt-3) |
| Remix | [Remix](#remix) |
| Something is not working | [Troubleshooting](#troubleshooting) |
| Making it faster | [Performance Tips](#performance-tips) |

## The recommended approach

**Starting with v1.2.0**, the library uses a simple URL-based API inspired by ffmpeg.wasm:

```typescript
import { initialize } from "texture2ddecoder-wasm";

// Copy WASM files to your public directory first
// npx texture2ddecoder-copy-wasm public/wasm

await initialize({ wasmPath: "/wasm" });
```

Why it works well:

- The API is simple and clean: no module factory imports are needed.
- It works with modern frameworks (React, Vue, Svelte).
- It is SSR-compatible (Next.js, Nuxt, SvelteKit).
- It is CDN-friendly for quick prototyping.
- It is the same pattern as popular libraries like ffmpeg.wasm.

---

## CDN Usage (No Bundler)

The fastest way to get started: no installation or build tools required.

Checklist:

1. Import `initialize` and the decode functions from the jsDelivr URL.
2. Pass the CDN `wasm` folder as `wasmPath`.
3. Serve the page over HTTP (see the [CDN example README](examples/cdn-example-README.md)).

### Basic Usage

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Texture Decoder</title>
  </head>
  <body>
    <script type="module">
      // Import from jsDelivr CDN
      import {
        initialize,
        decode_bc1,
      } from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/dist/index.mjs";

      // Point to WASM files on CDN
      await initialize({
        wasmPath:
          "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
      });

      // Ready to decode!
      console.log("Decoder initialized from CDN");
    </script>
  </body>
</html>
```

### CDN URLs

**Specific version (recommended for production):**

```
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/dist/index.mjs
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm/
```

**Latest version (good for development):**

```
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm/dist/index.mjs
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm/wasm/
```

**Version range:**

```
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/dist/index.mjs  // Latest 1.x.x
https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2/dist/index.mjs  // Latest 1.2.x
```

### Benefits

- **Zero setup:** no npm, no build tools, just HTML.
- **Global CDN:** fast loading from jsDelivr's worldwide network.
- **Cached:** the cache is shared across websites that use the same version.
- **Always available:** you do not host the WASM files yourself.

### Use Cases

- Quick prototypes and demos
- Codepen, JSFiddle, or other online editors
- Learning and experimentation
- Static sites without build process
- Documentation examples

### Complete Example

See [examples/cdn-example.html](examples/cdn-example.html) for a full working demo with UI.

### Alternative CDNs

You can also use other npm-based CDNs.

**unpkg:**

```javascript
import {
  initialize,
  decode_bc1,
} from "https://unpkg.com/texture2ddecoder-wasm@1.2.6/dist/index.mjs";
await initialize({
  wasmPath: "https://unpkg.com/texture2ddecoder-wasm@1.2.6/wasm",
});
```

**esm.sh** (the WASM files still come from jsDelivr in this example):

```javascript
import {
  initialize,
  decode_bc1,
} from "https://esm.sh/texture2ddecoder-wasm@1.2.6";
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});
```

---

## General Principles

These four rules hold for every bundler. The sections below only show how to apply them.

### 1. WASM Files Must Be Served Statically

WebAssembly modules cannot be bundled into JavaScript files. They must be:

- Copied to your public/static directory
- Served as separate files via HTTP(S)
- Accessible at runtime

The package ships a helper that does the copy: `npx texture2ddecoder-copy-wasm public/wasm`. Most
sections below use a plain `cp` or a bundler plugin instead; the result is the same.

### 2. Initialize with the Correct Path

```typescript
// Browser - provide the path where WASM files are served
await initialize({ wasmPath: "/wasm" });

// Node.js - no path needed (auto-resolved)
await initialize();
```

### 3. Environment Detection

The library automatically detects whether it is running in:

- **Browser:** loads WASM via fetch/script tag
- **Node.js:** loads WASM from the filesystem
- **Web Worker:** loads WASM with Worker-compatible methods

### 4. Keep Node.js Built-ins External

When bundling for browsers, always mark Node.js built-ins as external:

```javascript
external: ["path", "fs", "crypto", "module"];
```

---

## Vite

Checklist: install, copy the WASM files into `public/wasm`, then call
`initialize({ wasmPath: "/wasm" })`.

### Setup

1. **Install dependencies:**

```bash
npm install texture2ddecoder-wasm
```

2. **Copy WASM files:**

```bash
npx texture2ddecoder-copy-wasm public/wasm
```

3. **Use in your code:**

```typescript
// src/main.ts
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with path to WASM files
await initialize({ wasmPath: "/wasm" });

// Now you can decode textures
const decoded = await decode_bc1(textureData, 512, 512);
```

### Alternative: Automatic WASM copying (via plugin)

If you want WASM files copied automatically during build:

```bash
npm install vite-plugin-static-copy --save-dev
```

```javascript
// vite.config.js
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/texture2ddecoder-wasm/wasm/*",
          dest: "wasm",
        },
      ],
    }),
  ],
});
```

```typescript
// Then use normally
await initialize({ wasmPath: "/wasm" });
```

### Vite + React

```tsx
// src/App.tsx
import { useEffect, useState } from "react";
import { initialize } from "texture2ddecoder-wasm";

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initialize({ wasmPath: "/wasm" }).then(() => setReady(true));
  }, []);

  return ready ? <TextureViewer /> : <Loading />;
}
```

### Vite + Vue

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { initialize } from "texture2ddecoder-wasm";

const ready = ref(false);

onMounted(async () => {
  await initialize({ wasmPath: "/wasm" });
  ready.value = true;
});
</script>

<template>
  <div v-if="ready">Texture decoder ready!</div>
  <div v-else>Loading...</div>
</template>
```

---

## Webpack 5

Checklist: enable `asyncWebAssembly`, treat `.wasm` as an asset, copy the package's `wasm` folder
into `dist/wasm`, then call `initialize({ wasmPath: "/wasm" })`.

### Full Configuration

```javascript
// webpack.config.js
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: "./src/index.ts",

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].[contenthash].js",
    clean: true,
  },

  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true, // Optional, for cleaner async code
  },

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "wasm/[name][ext]",
        },
      },
    ],
  },

  resolve: {
    extensions: [".tsx", ".ts", ".js"],
    fallback: {
      // Browser polyfills for Node.js modules (if needed)
      path: false,
      fs: false,
      crypto: false,
    },
  },

  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/index.html",
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(
            __dirname,
            "node_modules/texture2ddecoder-wasm/wasm"
          ),
          to: path.resolve(__dirname, "dist/wasm"),
          noErrorOnMissing: false,
        },
      ],
    }),
  ],

  devServer: {
    static: {
      directory: path.join(__dirname, "dist"),
    },
    compress: true,
    port: 3000,
    // Ensure proper MIME types
    headers: {
      "Content-Type": "application/wasm",
    },
  },
};
```

### Webpack + TypeScript

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  }
}
```

---

## Next.js

Checklist: configure webpack in `next.config.js`, copy the WASM files into `public/wasm`, and
initialize only in the browser (inside `useEffect`, or a component loaded with `ssr: false`).

### App Router (Next.js 13+)

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer, dev }) => {
    // Enable WebAssembly
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Handle WASM files
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
      generator: {
        filename: "static/wasm/[name].[hash][ext]",
      },
    });

    // For server-side, keep Node.js built-ins external
    if (isServer) {
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push("path", "fs", "crypto");
      }
    }

    return config;
  },

  // Disable static page generation errors for dynamic imports
  experimental: {
    esmExternals: "loose",
  },
};

module.exports = nextConfig;
```

```bash
# Copy WASM files to public
mkdir -p public/wasm
cp node_modules/texture2ddecoder-wasm/wasm/* public/wasm/
```

```typescript
// app/texture-viewer/page.tsx
"use client";

import { useEffect, useState } from "react";
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

export default function TextureViewer() {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only run in browser
    if (typeof window === "undefined") return;

    initialize({ wasmPath: "/wasm" })
      .then(() => setIsReady(true))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div>Error: {error}</div>;
  if (!isReady) return <div>Loading WASM...</div>;

  return <div>Ready to decode textures!</div>;
}
```

### Pages Router (Next.js 12)

```typescript
// pages/index.tsx
import { useEffect, useState } from "react";
import type { NextPage } from "next";
import dynamic from "next/dynamic";

// Disable SSR for this component
const TextureDecoder = dynamic(() => import("../components/TextureDecoder"), {
  ssr: false,
});

const Home: NextPage = () => {
  return (
    <div>
      <h1>Texture Decoder</h1>
      <TextureDecoder />
    </div>
  );
};

export default Home;
```

```typescript
// components/TextureDecoder.tsx
import { useEffect, useState } from "react";
import { initialize } from "texture2ddecoder-wasm";

export default function TextureDecoder() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initialize({ wasmPath: "/wasm" }).then(() => setReady(true));
  }, []);

  return ready ? <div>Ready!</div> : <div>Loading...</div>;
}
```

---

## Create React App (CRA)

Checklist: CRA hides its webpack config, so either use `react-app-rewired` to copy the files in the
build, or copy them into `public/` yourself.

### Using react-app-rewired

1. **Install dependencies:**

```bash
npm install texture2ddecoder-wasm
npm install react-app-rewired copy-webpack-plugin --save-dev
```

2. **Create config-overrides.js:**

```javascript
// config-overrides.js
const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = function override(config, env) {
  // Add WASM support
  config.experiments = {
    ...config.experiments,
    asyncWebAssembly: true,
  };

  // Copy WASM files
  config.plugins.push(
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(
            __dirname,
            "node_modules/texture2ddecoder-wasm/wasm"
          ),
          to: path.resolve(
            __dirname,
            env === "production" ? "build/wasm" : "public/wasm"
          ),
        },
      ],
    })
  );

  return config;
};
```

3. **Update package.json:**

```json
{
  "scripts": {
    "start": "react-app-rewired start",
    "build": "react-app-rewired build",
    "test": "react-app-rewired test"
  }
}
```

### Manual Setup (Without Rewiring)

```bash
# Simply copy WASM files to public
cp -r node_modules/texture2ddecoder-wasm/wasm public/

# Add to .gitignore
echo "public/wasm/" >> .gitignore
```

Add a postinstall script:

```json
{
  "scripts": {
    "postinstall": "cp -r node_modules/texture2ddecoder-wasm/wasm public/"
  }
}
```

---

## Rollup

Checklist: keep Node.js built-ins external and copy the `wasm` folder into `dist/wasm` with
`rollup-plugin-copy`.

```javascript
// rollup.config.js
import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import copy from "rollup-plugin-copy";

export default {
  input: "src/index.ts",

  output: [
    {
      file: "dist/index.cjs",
      format: "cjs",
      sourcemap: true,
      exports: "named",
    },
    {
      file: "dist/index.mjs",
      format: "es",
      sourcemap: true,
    },
  ],

  external: ["path", "fs", "crypto"],

  plugins: [
    resolve({
      browser: false,
      preferBuiltins: true,
      extensions: [".js", ".ts"],
    }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
      sourceMap: true,
    }),
    copy({
      targets: [
        {
          src: "node_modules/texture2ddecoder-wasm/wasm/*",
          dest: "dist/wasm",
        },
      ],
      hook: "writeBundle",
    }),
  ],
};
```

---

## Parcel

Checklist: install `parcel-reporter-static-files-copy`, add it to `.parcelrc`, and list the WASM
folder under `staticFiles` in `package.json`.

```bash
# Install dependencies
npm install texture2ddecoder-wasm
npm install parcel-reporter-static-files-copy --save-dev
```

```json
// .parcelrc
{
  "extends": "@parcel/config-default",
  "reporters": ["...", "parcel-reporter-static-files-copy"]
}
```

```json
// package.json
{
  "staticFiles": {
    "staticPath": [
      {
        "staticPath": "node_modules/texture2ddecoder-wasm/wasm",
        "staticOutPath": "wasm"
      }
    ]
  }
}
```

---

## esbuild

Checklist: keep Node.js built-ins external and copy the `wasm` folder into `dist/wasm` in an
`onEnd` hook.

```javascript
// build.js
const esbuild = require("esbuild");
const { copy } = require("esbuild-plugin-copy");
const fs = require("fs");
const path = require("path");

esbuild
  .build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/bundle.js",
    format: "esm",
    platform: "browser",
    target: "es2020",
    sourcemap: true,

    external: ["path", "fs", "crypto"],

    plugins: [
      {
        name: "copy-wasm",
        setup(build) {
          build.onEnd(() => {
            const wasmSrc = path.join(
              __dirname,
              "node_modules/texture2ddecoder-wasm/wasm"
            );
            const wasmDest = path.join(__dirname, "dist/wasm");

            if (!fs.existsSync(wasmDest)) {
              fs.mkdirSync(wasmDest, { recursive: true });
            }

            fs.readdirSync(wasmSrc).forEach((file) => {
              fs.copyFileSync(
                path.join(wasmSrc, file),
                path.join(wasmDest, file)
              );
            });

            console.log("✓ WASM files copied");
          });
        },
      },
    ],
  })
  .catch(() => process.exit(1));
```

---

## SvelteKit

Checklist: copy the WASM files into `static/`, exclude the package from Vite's dependency
optimization, and initialize in `onMount`.

```bash
# Copy WASM to static
cp -r node_modules/texture2ddecoder-wasm/wasm static/
```

```javascript
// svelte.config.js
import adapter from "@sveltejs/adapter-auto";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),

    vite: {
      optimizeDeps: {
        exclude: ["texture2ddecoder-wasm"],
      },

      server: {
        fs: {
          allow: [".."],
        },
      },
    },
  },
};

export default config;
```

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { initialize, decode_bc1 } from 'texture2ddecoder-wasm';

  let isReady = false;
  let error: string | null = null;

  onMount(async () => {
    try {
      await initialize({ wasmPath: "/wasm" });
      isReady = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error';
    }
  });
</script>

{#if error}
  <p class="error">Error: {error}</p>
{:else if !isReady}
  <p>Loading texture decoder...</p>
{:else}
  <p>Texture decoder ready!</p>
{/if}
```

---

## Angular

Checklist: copy the WASM files into `src/assets/wasm`, add the `wasm` folder to the `assets` of
both `build` and `test` in `angular.json`, and initialize once from a service.

```bash
# Copy WASM to assets
mkdir -p src/assets/wasm
cp node_modules/texture2ddecoder-wasm/wasm/* src/assets/wasm/
```

```json
// angular.json
{
  "projects": {
    "your-app": {
      "architect": {
        "build": {
          "options": {
            "assets": [
              "src/favicon.ico",
              "src/assets",
              {
                "glob": "**/*",
                "input": "node_modules/texture2ddecoder-wasm/wasm",
                "output": "/wasm"
              }
            ],
            "scripts": []
          }
        },
        "test": {
          "options": {
            "assets": [
              "src/favicon.ico",
              "src/assets",
              {
                "glob": "**/*",
                "input": "node_modules/texture2ddecoder-wasm/wasm",
                "output": "/wasm"
              }
            ]
          }
        }
      }
    }
  }
}
```

```typescript
// src/app/services/texture-decoder.service.ts
import { Injectable } from "@angular/core";
import { initialize } from "texture2ddecoder-wasm";

@Injectable({
  providedIn: "root",
})
export class TextureDecoderService {
  private initialized = false;

  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await initialize({ wasmPath: "/wasm" });
      this.initialized = true;
    }
  }
}
```

```typescript
// src/app/components/texture-viewer.component.ts
import { Component, OnInit } from "@angular/core";
import { TextureDecoderService } from "../services/texture-decoder.service";

@Component({
  selector: "app-texture-viewer",
  template: `
    <div *ngIf="isReady; else loading">
      <p>Texture decoder ready!</p>
    </div>
    <ng-template #loading>
      <p>Loading...</p>
    </ng-template>
  `,
})
export class TextureViewerComponent implements OnInit {
  isReady = false;

  constructor(private decoderService: TextureDecoderService) {}

  async ngOnInit() {
    await this.decoderService.ensureInitialized();
    this.isReady = true;
  }
}
```

---

## Astro

Checklist: copy the WASM files into `public/` and initialize in a client-side `<script>`.

```bash
# Copy WASM to public
cp -r node_modules/texture2ddecoder-wasm/wasm public/
```

```astro
---
// src/pages/index.astro
---

<html>
  <head>
    <title>Texture Decoder</title>
  </head>
  <body>
    <div id="app">
      <div id="status">Loading...</div>
    </div>

    <script>
      import { initialize, decode_bc1 } from 'texture2ddecoder-wasm';

      const statusEl = document.getElementById('status');

      try {
        await initialize({ wasmPath: "/wasm" });
        statusEl.textContent = 'Texture decoder ready!';
      } catch (error) {
        statusEl.textContent = `Error: ${error.message}`;
      }
    </script>
  </body>
</html>
```

---

## Nuxt 3

Checklist: copy the WASM files into `public/`, exclude the package from Vite's dependency
optimization, and import it dynamically in `onMounted` so it never runs on the server.

```bash
# Copy WASM to public
cp -r node_modules/texture2ddecoder-wasm/wasm public/
```

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  vite: {
    optimizeDeps: {
      exclude: ["texture2ddecoder-wasm"],
    },
  },

  nitro: {
    externals: {
      inline: ["texture2ddecoder-wasm"],
    },
  },
});
```

```vue
<!-- pages/index.vue -->
<script setup lang="ts">
const isReady = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const { initialize } = await import("texture2ddecoder-wasm");
    await initialize({ wasmPath: "/wasm" });
    isReady.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unknown error";
  }
});
</script>

<template>
  <div>
    <div v-if="error" class="error">Error: {{ error }}</div>
    <div v-else-if="!isReady">Loading texture decoder...</div>
    <div v-else>Texture decoder ready!</div>
  </div>
</template>
```

---

## Remix

Checklist: copy the WASM files into `public/` and import the package dynamically inside
`useEffect` to avoid SSR problems.

```bash
# Copy WASM to public
cp -r node_modules/texture2ddecoder-wasm/wasm public/
```

```typescript
// app/routes/index.tsx
import { useEffect, useState } from "react";

export default function Index() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Dynamic import to avoid SSR issues
    import("texture2ddecoder-wasm").then(async ({ initialize }) => {
      await initialize({ wasmPath: "/wasm" });
      setIsReady(true);
    });
  }, []);

  return (
    <div>{isReady ? <h1>Texture decoder ready!</h1> : <h1>Loading...</h1>}</div>
  );
}
```

---

## Troubleshooting

Find your error message below. Most problems come down to the WASM files not being served from
the path you gave `initialize()`.

### Issue: "Cannot find module 'texture2ddecoder-wasm'"

**Cause:** Package not installed or not in node_modules

**Solution:**

```bash
npm install texture2ddecoder-wasm
# or
yarn add texture2ddecoder-wasm
```

### Issue: "Failed to load WASM file"

**Cause:** WASM files not copied to public directory or wrong path

**Solution:**

1. Verify WASM files exist:

```bash
ls public/wasm/
# Should show: texture2ddecoder.js, texture2ddecoder.wasm
```

2. Check browser console for the actual path being requested

3. Verify path in initialize call matches served location:

```typescript
await initialize({ wasmPath: "/wasm" }); // Must match public directory structure
```

### Issue: "MIME type mismatch for WASM file"

**Cause:** Server not configured to serve .wasm files with correct MIME type

**Solution:**

**Express:**

```javascript
app.use(
  express.static("public", {
    setHeaders: (res, path) => {
      if (path.endsWith(".wasm")) {
        res.set("Content-Type", "application/wasm");
      }
    },
  })
);
```

**Nginx:**

```nginx
location ~ \.wasm$ {
    types { application/wasm wasm; }
}
```

**Apache (.htaccess):**

```apache
AddType application/wasm .wasm
```

### Issue: Content Security Policy (CSP) Errors

**Cause:** CSP headers blocking WebAssembly execution

**Solution:**

Add `wasm-unsafe-eval` to your CSP:

```html
<meta
  http-equiv="Content-Security-Policy"
  content="script-src 'self' 'wasm-unsafe-eval'; default-src 'self'"
/>
```

Or in server headers:

```javascript
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'
```

### Issue: "Module is not defined" in Node.js

**Cause:** Trying to use browser build in Node.js

**Solution:**

Ensure you're using the correct Node.js import and not bundling for browser:

```typescript
// Node.js - this should work without bundler config
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

await initialize(); // No path needed in Node.js
```

### Issue: Build size is too large

**Cause:** WASM files being bundled into JavaScript bundle

**Solution:**

1. Ensure WASM files are marked as external/assets
2. Use code splitting for the texture decoder:

```typescript
// Lazy load only when needed
const loadDecoder = async () => {
  const decoder = await import("texture2ddecoder-wasm");
  await decoder.initialize({ wasmPath: "/wasm" });
  return decoder;
};

// Use only when needed
button.onclick = async () => {
  const decoder = await loadDecoder();
  await decoder.decode_bc1(data, width, height);
};
```

### Issue: TypeScript errors about types

**Cause:** TypeScript can't find type definitions

**Solution:**

```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### Issue: Works in development but not production

**Cause:** WASM files not included in production build

**Solution:**

Verify your build process includes WASM files:

1. Check build output directory
2. Ensure copy plugin runs in production mode
3. Verify deployment includes `wasm/` directory

```bash
# Check production build
ls dist/wasm/
# or
ls build/wasm/
```

---

## Performance Tips

### 1. Lazy Loading

Only load WASM when you need it:

```typescript
// Don't initialize on app start
// Initialize when user loads texture viewer
const handleViewTexture = async () => {
  const decoder = await import("texture2ddecoder-wasm");
  await decoder.initialize({ wasmPath: "/wasm" });
  // Now decode...
};
```

### 2. Singleton Pattern

Initialize once and reuse:

```typescript
// src/utils/texture-decoder.ts
import { initialize } from "texture2ddecoder-wasm";

let initialized = false;

export async function ensureDecoder() {
  if (!initialized) {
    await initialize({ wasmPath: "/wasm" });
    initialized = true;
  }
}
```

### 3. Preloading

Preload WASM files while app is loading:

```html
<link rel="preload" href="/wasm/texture2ddecoder.wasm" as="fetch" crossorigin />
<link rel="preload" href="/wasm/texture2ddecoder.js" as="script" />
```

### 4. Caching

Configure proper cache headers for WASM files:

```javascript
// Cache WASM files for 1 year
app.use(
  "/wasm",
  express.static("public/wasm", {
    maxAge: "1y",
    immutable: true,
  })
);
```

---

## Additional Resources

- [Emscripten Documentation](https://emscripten.org/docs/)
- [WebAssembly MDN](https://developer.mozilla.org/en-US/docs/WebAssembly)
- [texture2ddecoder-wasm GitHub](https://github.com/fatal10110/unity-asset-reader)

---

## Contributing

Found a problem with these configurations, or want to add a new bundler? [Open an
issue](https://github.com/fatal10110/unity-asset-reader/issues) or submit a pull request.
