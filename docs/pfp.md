# Profile picture editor

Route: `/pfp` (also `/pfp/`). The transparent frame is the user-supplied original, copied without modification. Cropper.js 2.2 handles drag, touch zoom, slider and keyboard positioning. PNG export is 1024 × 1024 with the unchanged arch/agent composited over the selected picture. Circular previews show the profile crop; the download remains square.

## Run

```sh
cd ~/Code/afterhours-agentic-dao
pnpm install --frozen-lockfile
pnpm build
WEB_PORT=8785 pnpm start:web
```

Open http://localhost:8785/pfp. The page needs no AI service or wallet. Uploads are decoded and composited entirely in the browser; no upload endpoint exists. Supported local formats: JPEG, PNG, WebP, up to 10 MB / 40 megapixels.

## X avatar lookup

`GET /api/pfp/avatar?handle=...` accepts a handle or X/Twitter profile URL. The server validates it and requests only `https://unavatar.io/x/{handle}?fallback=false`. Redirects and unsupported response formats are rejected. The proxy makes the image available from the same origin for canvas export. Public X handles are sent to Unavatar when the user chooses Find picture. Uploads never use Unavatar.

Optional `UNAVATAR_API_KEY` belongs only in the server environment. Free Unavatar access is currently limited to 25 requests/day per IP and requires the visible attribution link included in the UI. See https://unavatar.io/docs for current terms. The app also bounds upstream attempts (10/minute, four concurrent, 25/day without a key, 500/day with a key), coalesces duplicate requests, and caches up to 12 MB for one hour. Those in-memory limits reset on restart; use a shared limiter for multiple replicas. Provider quotas still apply. Returned pictures may be smaller than their source; uploading the original gives the best quality.

The upload path remains available when X lookup fails or reaches its quota. No X login, profile update, posting, or public image gallery is implemented.

## Verify

`pnpm test` covers route serving, handle validation, fixed upstream URLs, cache/coalescing, provider failure, image byte/type limits and rate limiting. Browser checks cover upload, X fetch, drag/zoom, circular preview, and PNG download.
