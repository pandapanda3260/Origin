/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: false,
  // @napi-rs/canvas / better-sqlite3 都带原生 .node 二进制；webpack 会试图打包
  // 这些 .node 然后炸掉整条路由（500 HTML 页面）。serverComponentsExternalPackages
  // 让它们直接走 require()，绕过 webpack 打包。
  experimental: {
    serverComponentsExternalPackages: ['@napi-rs/canvas', 'better-sqlite3'],
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', destination: '/index.html' },
        { source: '/workspace', destination: '/workspace.html' },
      ],
    };
  },
  async headers() {
    return [
      {
        source: '/workspace',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/workspace.html',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/vendor/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
  webpack(config) {
    config.watchOptions = {
      ...(config.watchOptions || {}),
      ignored: /[\\/](node_modules|vevdemo-1\.0\.6|\.git|\.next|\.next-dev)[\\/]/,
    };
    return config;
  },
};

export default nextConfig;
