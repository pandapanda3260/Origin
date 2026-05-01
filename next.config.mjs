/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // @napi-rs/canvas / better-sqlite3 都带原生 .node 二进制；webpack 会试图打包
  // 这些 .node 然后炸掉整条路由（500 HTML 页面）。serverComponentsExternalPackages
  // 让它们直接走 require()，绕过 webpack 打包。
  experimental: {
    serverComponentsExternalPackages: ['@napi-rs/canvas', 'better-sqlite3'],
  },
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/workspace', destination: '/workspace.html' },
    ];
  },
};

export default nextConfig;
