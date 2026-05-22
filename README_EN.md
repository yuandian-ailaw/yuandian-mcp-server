<p align="right">
  <a href="./README.md">简体中文</a> | English
</p>

# Yuandian Open Platform MCP Server

This MCP Server reads the Yuandian Open Platform API catalog on startup and dynamically registers open APIs as MCP tools, allowing MCP-compatible AI clients to directly call legal data and services. Business API requests are forwarded to `https://open.chineselaw.com/open/{routeKey}` and authenticated with the `X-API-Key` header.

## Get an API Key

Before using this server, visit the [Yuandian Open Platform](https://open.chineselaw.com/) to register or log in, then obtain an API Key from the platform.

Platform campaign: From April 27, 2026 to July 26, 2026, users receive a monthly benefits package of 50,000 credits. The detailed campaign rules are subject to the Yuandian Open Platform page.

## Quick Start

```bash
YUANDIAN_API_KEY="your_api_key" npx -y yuandian-mcp-server
```

You can also install it in the current project first:

```bash
npm install yuandian-mcp-server
YUANDIAN_API_KEY="your_api_key" npx yuandian-mcp-server
```

Or install it globally and run it directly:

```bash
npm install -g yuandian-mcp-server
YUANDIAN_API_KEY="your_api_key" yuandian-mcp-server
```

Node.js 20 or higher is required.

## MCP Client Configuration Example

```json
{
  "mcpServers": {
    "yuandian-mcp-server": {
      "command": "npx",
      "args": ["-y", "yuandian-mcp-server"],
      "env": {
        "YUANDIAN_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Environment Variables

- `YUANDIAN_API_KEY`: Yuandian Open Platform API Key.

## Registered Tools

- `yuandian_list_apis`: View the list of APIs discovered at startup.
- `yuandian_get_api_document`: Read the Markdown documentation for a specific API.
- `yuandian_{routeKey}`: Dynamically registered business API tools, such as `yuandian_law_vector_search` and `yuandian_rh_enterpriseSearch`.

## Related Links

| Category | Links |
| --- | --- |
| Company | [About Us](https://yuandian.ailaw.cn) · [Contact Us](https://yuandian.feishu.cn/share/base/form/shrcnX8MRiwL8DAksin7t85XjUd) |
| Product Features | [API Square](https://open.chineselaw.com/api-square) · [MCP Server](https://open.chineselaw.com/mcp-config) · [API Documentation](https://open.chineselaw.com/docs) · [New Site Benefits](https://open.chineselaw.com/activity) |
| Yuandian Ecosystem | [Yuandian Think Tank](https://www.chineselaw.com) · [Yuandian Amicus](https://ami.ailaw.cn) · [Yuandian Data Masking](https://tuomin.ailaw.cn) · [Legal Yuanli](https://yuanli.ailaw.cn) |
