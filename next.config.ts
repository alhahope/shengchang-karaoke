import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: isGitHubPages ? "/shengchang-karaoke" : undefined,
  trailingSlash: isGitHubPages,
  typescript: isGitHubPages
    ? { tsconfigPath: "tsconfig.pages.json" }
    : undefined,
};

export default nextConfig;
