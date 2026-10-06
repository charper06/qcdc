# DC Quality Audit System — Installable PWA

This package is the mobile-first web/PWA version of the DC Quality Audit V8 application.

## What it provides
- Existing V8 audit/report engine and localStorage data model
- Supplier Reports with date ranges and PO-pass-rate Overall Quality Score
- iPhone/iPad standalone installation from Safari
- Offline app-shell caching after the first successful load
- Custom Home Screen icon
- Responsive mobile layout

## Important: HTTPS is required
Safari's "Add to Home Screen" / standalone PWA behavior requires the site to be served from HTTPS (localhost is an exception for development).

## Fastest deployment: GitHub Pages
1. Create a GitHub repository.
2. Upload **the contents of this folder** (not the outer folder itself).
3. Enable GitHub Pages for the repository from Settings → Pages.
4. Wait for the HTTPS Pages URL to become available.
5. On the iPhone, open that HTTPS URL in Safari.
6. Tap Share → Add to Home Screen → Add.

## Alternative hosting
Any HTTPS static host works, including Cloudflare Pages, Netlify, Vercel, Azure Static Web Apps, or a normal HTTPS web server.

## iPhone installation
1. Open the HTTPS site in Safari.
2. Tap the Share button.
3. Choose **Add to Home Screen**.
4. Name it **DC Quality Audit**.
5. Tap Add.
6. Launch it from the Home Screen.

## Data / synchronization note
This build retains the application's existing localStorage data behavior. The Windows File System Access API based shared OneDrive/SharePoint folder synchronization is not available to Safari/iOS in the same way. For true cross-device shared data, a server/cloud data layer should be added rather than relying on localStorage.
