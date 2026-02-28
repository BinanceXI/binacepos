#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const sourceLogoPath = path.join(repoRoot, "src/assets/binancexi-receipt-logo.svg");
const squareMasterPath = path.join(repoRoot, "src/assets/binancexi-app-icon-square.svg");
const tauriAndroidIconsDir = path.join(repoRoot, "src-tauri/icons/android");
const capacitorResDir = path.join(repoRoot, "android/app/src/main/res");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function ensureSourceLogo() {
  if (existsSync(sourceLogoPath)) return;
  throw new Error(`Missing source logo: ${sourceLogoPath}`);
}

function writeSquareMasterSvg() {
  const logoSvg = readFileSync(sourceLogoPath, "utf8");
  const logoSvgB64 = Buffer.from(logoSvg, "utf8").toString("base64");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="BinanceXI app icon">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#051a2b"/>
      <stop offset="100%" stop-color="#0b2f49"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="196" fill="url(#bg)" />
  <rect x="40" y="40" width="944" height="944" rx="184" fill="#08263a" stroke="#1f4e6a" stroke-width="8" />
  <image
    href="data:image/svg+xml;base64,${logoSvgB64}"
    x="112"
    y="332"
    width="800"
    height="360"
    preserveAspectRatio="xMidYMid meet"
  />
</svg>
`;
  writeFileSync(squareMasterPath, svg, "utf8");
}

function generateTauriIcons() {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npxCmd, ["tauri", "icon", squareMasterPath], repoRoot);
}

function copyCapacitorAndroidIcons() {
  const requiredPaths = [
    "mipmap-mdpi/ic_launcher.png",
    "mipmap-mdpi/ic_launcher_round.png",
    "mipmap-mdpi/ic_launcher_foreground.png",
    "mipmap-hdpi/ic_launcher.png",
    "mipmap-hdpi/ic_launcher_round.png",
    "mipmap-hdpi/ic_launcher_foreground.png",
    "mipmap-xhdpi/ic_launcher.png",
    "mipmap-xhdpi/ic_launcher_round.png",
    "mipmap-xhdpi/ic_launcher_foreground.png",
    "mipmap-xxhdpi/ic_launcher.png",
    "mipmap-xxhdpi/ic_launcher_round.png",
    "mipmap-xxhdpi/ic_launcher_foreground.png",
    "mipmap-xxxhdpi/ic_launcher.png",
    "mipmap-xxxhdpi/ic_launcher_round.png",
    "mipmap-xxxhdpi/ic_launcher_foreground.png",
    "mipmap-anydpi-v26/ic_launcher.xml",
    "values/ic_launcher_background.xml",
  ];

  for (const relPath of requiredPaths) {
    const from = path.join(tauriAndroidIconsDir, relPath);
    const to = path.join(capacitorResDir, relPath);
    if (!existsSync(from)) {
      throw new Error(`Missing generated icon: ${from}`);
    }
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { force: true });
  }
}

function main() {
  ensureSourceLogo();
  writeSquareMasterSvg();
  generateTauriIcons();
  copyCapacitorAndroidIcons();
  console.log("Icon generation complete:");
  console.log(`- square master: ${squareMasterPath}`);
  console.log("- Tauri icons regenerated");
  console.log("- Capacitor Android mipmap icons synced");
}

main();
