# Origin Agent Notes

Before changing model calls, reasoning effort, providers, endpoints, API keys, image quality, video settings, or related routing, read:

- [Model Configuration Governance](docs/model-config-governance.md)

Model-call parameters should be controlled through `.env.local`, the external env file, and `lib/model-routing.ts`; business routes should generally choose a `modelRole` instead of hardcoding tunable settings.
