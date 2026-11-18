import { generateUserGuide } from "./scripts/generate-user-guide.mjs";
generateUserGuide();

import { fileURLToPath } from "node:url";

// Static export：`NEXT_EXPORT=1 next build` Output pure static directory to web/out，can be thrown directly into
// nginx web Run from root directory. develop(next dev)Do not set this variable and keep it /api Reverse generation and hot update。
const isExport = process.env.NEXT_EXPORT === "1";
// Vercel demo：Walk the entire station mock，No backend, no need /api Anti-generation。
const isMock = process.env.NEXT_PUBLIC_MOCK === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Avoid parent directories lockfile Affects root directory inference and resource path generation。
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  reactCompiler: true,
  // Allow access from LAN IP Visit dev Resources（HMR），Add or delete as needed。
  // dev The stage is free IPv4 Source Access /_next/* and HMR（LAN IP Changes are not affected）。
  // NOTE：Next Nudity is prohibited for safety reasons "*"，Segmented wildcarding is required；"*.*.*.*" Match any IPv4。
  allowedDevOrigins: ["*.*.*.*"],
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  ...(isExport
    ? {
        // Pure static export: None Node Runtime; images not optimized; output per route <route>/index.html。
        output: "export",
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : isMock
      ? {
          // Vercel mock demo：No backend, not required /api Anti-generation。
          images: { unoptimized: true },
        }
      : {
          // Development: put /api/* Forward to WORMHOLE API；Old environment variables are still compatible。
          async rewrites() {
            const backend = process.env.WORMHOLE_API_URL ?? "http://localhost:18887";
            return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
          },
        }),
};

export default nextConfig;
