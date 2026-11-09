# CDN Example - README

`cdn-example.html` is a single page that loads `texture2ddecoder-wasm` from the jsDelivr CDN. It
needs no install and no build tools. Serve it over HTTP and open it in a browser.

## Quick Start

### How to Run

**Important:** Serve the file over HTTP. Opening it with `file://` causes CORS errors.

#### Option 1: Python HTTP Server (Recommended)

```bash
# Navigate to the examples directory
cd examples

# Start HTTP server
python -m http.server 8000

# Open in browser
# Visit: http://localhost:8000/cdn-example.html
```

#### Option 2: Node.js HTTP Server

```bash
# Install http-server globally (one time)
npm install -g http-server

# Navigate to examples directory
cd examples

# Start server
http-server -p 8000

# Visit: http://localhost:8000/cdn-example.html
```

#### Option 3: PHP Built-in Server

```bash
cd examples
php -S localhost:8000

# Visit: http://localhost:8000/cdn-example.html
```

#### Option 4: VS Code Live Server Extension

1. Install "Live Server" extension in VS Code
2. Right-click on `cdn-example.html`
3. Select "Open with Live Server"

## Features

- **Zero installation:** no npm packages needed.
- **CDN loading:** the library and the WASM load from jsDelivr.
- **Real texture:** loads and decodes an actual 400x400 ETC2 RGBA image.
- **Interactive:** test several texture formats (BC1, BC3, ETC1, ASTC).
- **Visual output:** shows the decoded images on a canvas.

## What It Does

1. Loads `texture2ddecoder-wasm` from jsDelivr CDN
2. Initializes WASM module from CDN
3. Provides buttons to test different texture decoders
4. The **"Load Real ETC2 Image"** button loads `compressed_etc2_rgba_400x400.bin` and shows it

## Troubleshooting

### CORS Error

```
Access to fetch at 'file://...' has been blocked by CORS policy
```

**Solution:** You opened the file directly. Use an HTTP server as shown above.

### File Not Found (404)

Make sure you're running the server from the `examples` directory, not the root project directory.

```bash
# Wrong - from project root
python -m http.server 8000  # ❌

# Correct - from examples directory
cd examples
python -m http.server 8000  # ✅
```

## Technical Details

- **Texture Format**: ETC2 RGBA (8-bit alpha)
- **File Size**: ~160KB compressed
- **Dimensions**: 400x400 pixels
- **Output Format**: BGRA (4 bytes per pixel)
- **Decoded Size**: 640KB

## Next Steps

For hot reload (HMR) and build tools, try the [Vite CDN Example](vite-cdn-example/).
