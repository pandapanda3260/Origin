/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/workspace', destination: '/workspace.html' },
    ];
  },
};

export default nextConfig;
