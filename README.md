# QRIS Dynamic Generator

Interactive QRIS utility built with React, TypeScript, and Vite. Paste or scan a static QRIS payload, add transaction details (amount, fees, merchant info), and the app recalculates the EMV payload plus a fresh CRC checksum before rendering a downloadable QR code.

## Support This Project

<p>
  <a href="https://saweria.co/HiddenCyber">
    <img src="https://asset.hiddencyber.online/donate-buttons/saweria.svg" alt="Donasi via Saweria" height="56">
  </a>

  <a href="https://support.hiddencyber.online">
    <img src="https://asset.hiddencyber.online/donate-buttons/qris.svg" alt="Dukungan via QRIS" height="56">
  </a>

  <a href="https://ko-fi.com/hiddencyber">
    <img src="https://asset.hiddencyber.online/donate-buttons/ko-fi.svg" alt="Ko-fi untuk HiddenCyber" height="56">
  </a>

  <a href="https://paypal.me/wimboro">
    <img src="https://asset.hiddencyber.online/donate-buttons/paypal.svg" alt="Donasi via PayPal" height="56">
  </a>
</p>

## Features
- Drag-and-drop or image upload with live QR decoding via `qr-scanner`
- Manual input for amounts, optional service fees (fixed or percentage), and merchant metadata
- Automatic CRC16 recalculation to keep generated QRIS valid
- One-click copy/download of the generated dynamic QR payload and QR image
- Light/dark theme toggle with preference persisted to `localStorage`
- Password-gated merchant metadata editing using `VITE_MERCHANT_PASSWORD`

## Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Installation
```bash
npm install
```

### Development Server
```bash
npm run dev
```
Vite prints a local URL; open it in your browser to interact with the app.

### Production Build
```bash
npm run build
```
Serve the generated assets in `dist/` (for example via `npm run preview`).

## Environment Variables

The admin unlock modal reads `VITE_MERCHANT_PASSWORD`. Set it in a `.env` file at the project root:

```
VITE_MERCHANT_PASSWORD=your-secret
```

When the modal is unlocked, merchant name, city, and country fields become editable.

## Tech Stack
- React 18 with TypeScript
- Vite 5
- Tailwind CSS 3
- `qr-scanner` for decoding QR images
- `qrcode` for generating QR bitmaps

## Project Structure (selected)
- `src/main.tsx` – Vite entry that mounts `<App />` and wires the theme provider
- `src/App.tsx` – Main UI and QRIS conversion logic
- `src/contexts/ThemeContext.tsx` – Theme state, toggling, and persistence
- `src/components/ThemeToggle.tsx` – Sun/moon toggle button component
