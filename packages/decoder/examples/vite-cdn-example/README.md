# Vite CDN Example

This example shows how to use `texture2ddecoder-wasm` with Vite, loading the library from the
jsDelivr CDN. It decodes a real ETC2 RGBA texture and draws it on a canvas.

## Features

- **Vite:** dev server with hot reload (HMR).
- **CDN loading:** the WASM files load from the jsDelivr CDN.
- **Interactive demo:** decode and show a real ETC2 RGBA texture.
- **Minimal setup:** almost no configuration.
- **Production build:** `npm run build`.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## How It Works

This example uses Vite as the development server and build tool, while loading the `texture2ddecoder-wasm` library and WASM files directly from jsDelivr CDN.

### Main Features

1. **CDN Import**: Library loaded from jsDelivr in `src/main.js`
2. **Real Texture Decoding**: Includes `compressed_etc2_rgba_400x400.bin`, a 400x400 PNG compressed as ETC2 RGBA
3. **Canvas Display**: Decoded images displayed in HTML canvas
4. **Multiple Formats**: Test BC1, BC3, ETC1, ASTC decoders

## Project Structure

```
vite-cdn-example/
├── index.html                              # Main HTML file
├── vite.config.js                          # Vite configuration
├── package.json                            # Dependencies
├── public/
│   └── compressed_etc2_rgba_400x400.bin   # ETC2 RGBA compressed texture (400x400 PNG)
└── src/
    ├── main.js                             # Application logic
    └── style.css                           # Styles
```

## Usage Example

```javascript
// Import from CDN
import {
  initialize,
  decode_etc2a8,
} from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/dist/index.mjs";

// Initialize with CDN path
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.6/wasm",
});

// Load and decode texture
const response = await fetch("/compressed_etc2_rgba_400x400.bin");
const data = new Uint8Array(await response.arrayBuffer());
const decoded = await decode_etc2a8(data, 400, 400);

// Display on canvas
const imageData = ctx.createImageData(400, 400);
// Convert BGRA to RGBA for canvas
for (let i = 0; i < decoded.length; i += 4) {
  imageData.data[i] = decoded[i + 2];     // R from B
  imageData.data[i + 1] = decoded[i + 1]; // G
  imageData.data[i + 2] = decoded[i];     // B from R
  imageData.data[i + 3] = decoded[i + 3]; // A
}
ctx.putImageData(imageData, 0, 0);
```

## Benefits of This Approach

### Development
- Hot module replacement (HMR)
- Better error messages and debugging
- ES module support
- No WASM file copying

### Production
- Optimized builds with code splitting
- Smaller bundles (the WASM loads from the CDN)
- Global CDN caching
- Version pinning for stability

## CDN vs Local WASM Files

This example uses CDN for both development and production:

**CDN benefits:**
- No manual file copying
- Cached globally by jsDelivr
- Faster setup
- Automatic updates (or pin a specific version)

**When to use local files:**
- Offline development
- Corporate firewalls
- Guaranteed availability
- Custom WASM builds

## Included Texture File

The `public/compressed_etc2_rgba_400x400.bin` file is a real 400x400 PNG image compressed as ETC2 RGBA format:
- Original: PNG image (400x400)
- Compressed: ETC2 RGBA (8-bit alpha)
- Size: ~160KB compressed → 640KB uncompressed (BGRA)

## Available Scripts

- `npm run dev` - Start Vite development server (http://localhost:3000)
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally

## Requirements

- Node.js >= 14.0.0
- Modern browser with WebAssembly support

## Next Steps

- See [main README](../../README.md) for API documentation
- Check [other examples](../) for different frameworks
- Try modifying `src/main.js` to decode different formats
