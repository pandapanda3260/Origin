# Known Limitations

## Online Editor Download SSRF

P1 validates download URL schemes, rejects private or link-local IPv4/IPv6 ranges, validates every redirect hop, and enforces a streamed byte limit.

It does not fully defend against DNS rebinding yet. The downloader resolves a hostname during validation, but the underlying `fetch()` call may resolve the hostname again during connection setup. A complete P2 fix should either pin the validated IP through a custom `lookup`/agent path or verify the connected socket `remoteAddress` before streaming response bytes.
