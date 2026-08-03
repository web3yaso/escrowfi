/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source with NodeNext-style `.js`
  // import specifiers; teach webpack to resolve them to `.ts`.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  transpilePackages: [
    "@citely-pay/pool",
    "@citely-pay/passport",
    "@citely-pay/chain",
    "@citely-pay/verify-adapter",
  ],
};

export default nextConfig;
