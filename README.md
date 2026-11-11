# web-research-mcp

A read-only MCP server that fetches public web pages and extracts clean text, metadata, headings, and focus-matched facts.

## Demo

<img width="1440" height="900" alt="Screenshot 2026-11-11 at 1 12 24 PM" src="https://github.com/user-attachments/assets/7cc69618-3f8a-4cec-bd67-9d8599d9aeb2" />


## Quickstart

Requires Node.js 20 or newer.

```bash
git clone <repository-url>
cd web-research-mcp
npm install
npm run build
npm run smoke
```

Replace `<repository-url>` with this repository's clone URL. `npm run smoke` spawns the built server over stdio, lists its tools, and calls both tools against `https://example.com/`. It requires internet access but no API key.

Run the offline test suite with:

```bash
npm test
```

## Connect to Cursor

Create `.cursor/mcp.json` in your project (or use your global Cursor MCP configuration) and replace the path with the absolute path to this checkout:

```json
{
  "mcpServers": {
    "web-research": {
      "command": "node",
      "args": ["/absolute/path/to/web-research-mcp/dist/index.js"]
    }
  }
}
```

Restart Cursor after saving the file.

## Connect to Claude Desktop

Add the server to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "web-research": {
      "command": "node",
      "args": ["/absolute/path/to/web-research-mcp/dist/index.js"]
    }
  }
}
```

On Windows, use an absolute path such as `C:\\path\\to\\web-research-mcp\\dist\\index.js`. Restart Claude Desktop after saving the file.

## Test with MCP Inspector

From the repository root, after building:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The Inspector opens a browser UI where you can list the tools and invoke them interactively.

## Tool reference

| Tool | Inputs | Output example |
| --- | --- | --- |
| `fetch_page` | `url` (string, required)<br>`maxChars` (number, 1–20,000, default 8,000) | `{"finalUrl":"https://example.com/","status":200,"contentType":"text/html","title":"Example Domain","text":"This domain is for use in documentation examples ...","truncated":false}` |
| `extract_facts` | `url` (string, required)<br>`focus` (string array, optional)<br>`maxFacts` (number, 1–25, default 10) | `{"metadata":{"title":"Example Domain","description":null,"canonicalUrl":null,"author":null,"publishedDate":null,"siteName":null,"language":"en"},"headings":[],"jsonLdTypes":[],"facts":[{"text":"This domain is for use in documentation examples without needing permission.","heading":null}]}` |

`extract_facts` includes the `facts` array only when `focus` is supplied. On failure, both tools return an MCP error result whose text body is JSON:

```json
{ "code": "INVALID_INPUT", "message": "url: Too small: expected string to have >=1 characters" }
```

## How it works

_Placeholder: document the end-to-end flow here (input validation, SSRF checks, HTTP fetch with redirects and limits, Cheerio content extraction, and JSON result formatting)._

## Known limitations

- No JavaScript-rendered pages. The server fetches and parses the initial HTML response; content rendered client-side by a SPA or infinite scroll is not available.
- No login or authenticated requests. Only public, unauthenticated pages can be fetched.
- DNS rebinding is not fully prevented. Hostnames are resolved and checked before `fetch()` connects, but the resolve-then-fetch sequence is not atomic, so a malicious DNS server could change the answer in between.
- Main-content extraction is heuristic. The parser prefers `article`, then `main`, then `body`, and removes common chrome; it can still include or omit the wrong content on unusual layouts.
- Responses are limited to HTML, 2 MB, and 10 seconds per fetch. Non-HTML content types and oversized responses are rejected.

## Example prompts

1. "Fetch https://example.com and summarize the main points in three bullets."
2. "Extract the title, author, publication date, and JSON-LD types from https://research.example/blog/post."
3. "Find every sentence about pricing on https://example.com/pricing and show the nearest heading for each quote."
