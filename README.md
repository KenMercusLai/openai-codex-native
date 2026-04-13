# OpenAI Codex Native

Alma provider plugin that delegates OpenAI requests to the local `codex app-server` over stdio. This avoids the Cloudflare 403 issue from direct `chatgpt.com/backend-api/codex/responses` calls by letting the official CLI handle auth and transport.

## What this build does

- Starts `codex app-server --listen stdio://` on demand
- Performs JSON-RPC initialize/model/list/thread/start/turn/start calls
- Reads models from `~/.codex/models_cache.json` with `model/list` refresh support
- Exposes an AI SDK-compatible `getSDKConfig()` using a custom `fetch`
- Converts Codex streaming notifications into OpenAI Responses API SSE
- Converts non-streaming requests by consuming the SSE stream and returning JSON

## Current scope

- Stateless conversation mode: every `/responses` request creates a fresh Codex thread
- Text and image input are supported
- Tool definitions are preserved in prompt context as plain-text guidance only
- Codex-side approvals are declined by default

## Known limitations

- Dynamic tool execution and native function-calling are not wired into Codex app-server yet
- No persistent thread/session reuse across Alma conversations yet
- Only the `/responses` and `/models` fetch paths are implemented
- Error handling is still minimal if the app-server dies mid-stream

## Files

- `manifest.json`: Alma plugin manifest
- `main.ts`: provider, stdio RPC client, model mapping, Responses proxy
- `CODEX-PLUGIN-SPEC.md`: original implementation spec

## Local runtime assumptions

- `codex` exists at `/opt/homebrew/bin/codex`
- `~/.codex/auth.json` contains a valid ChatGPT-authenticated session
- `~/.codex/models_cache.json` exists or Alma can fall back to a default GPT-5 model

## Next recommended work

1. Validate the plugin inside Alma by loading it from `~/.config/alma/plugins/openai-codex-native/`
2. Replace the schema-based tool bridge with native dynamic tool registration once the app-server surface is confirmed
3. Add thread reuse keyed by Alma conversation/session ids
