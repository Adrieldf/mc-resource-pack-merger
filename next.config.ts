import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/mc-resource-pack-merger',
  images: {
    unoptimized: true, // Required for static export
  },
};

export default nextConfig;
