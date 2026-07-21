import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
