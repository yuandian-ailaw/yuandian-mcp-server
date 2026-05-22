<p align="right">
  简体中文 | <a href="./README_EN.md">English</a>
</p>

# 元典开放平台 MCP Server

这个 MCP Server 会在启动时读取元典开放平台接口目录，并把开放接口动态注册成 MCP tool，方便支持 MCP 的 AI 客户端直接调用法律数据与服务。业务接口会转发到 `https://open.chineselaw.com/open/{routeKey}`，并使用 `X-API-Key` 头鉴权。

## 获取 API Key

使用前需要访问 [元典开放平台](https://open.chineselaw.com/) 注册或登录，并在平台中获取 API Key。

平台活动：2026 年 4 月 27 日至 2026 年 7 月 26 日期间，每月赠送 50,000 积分权益包。具体活动规则以元典开放平台页面为准。

## 快速开始

```bash
YUANDIAN_API_KEY="你的_api_key" npx -y yuandian-mcp-server
```

也可以先安装到当前项目：

```bash
npm install yuandian-mcp-server
YUANDIAN_API_KEY="你的_api_key" npx yuandian-mcp-server
```

或全局安装后直接运行：

```bash
npm install -g yuandian-mcp-server
YUANDIAN_API_KEY="你的_api_key" yuandian-mcp-server
```

Node.js 版本需为 20 或更高。

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "yuandian-mcp-server": {
      "command": "npx",
      "args": ["-y", "yuandian-mcp-server"],
      "env": {
        "YUANDIAN_API_KEY": "你的_api_key"
      }
    }
  }
}
```

## 环境变量

- `YUANDIAN_API_KEY`：元典开放平台 API Key。

## 注册的工具

- `yuandian_list_apis`：查看启动时发现的接口清单。
- `yuandian_get_api_document`：读取某个接口的 Markdown 文档。
- `yuandian_{routeKey}`：动态注册的业务接口工具，例如 `yuandian_law_vector_search`、`yuandian_rh_enterpriseSearch`。

## 相关链接

| 分类 | 链接 |
| --- | --- |
| 公司 | [关于我们](https://yuandian.ailaw.cn) · [联系我们](https://yuandian.feishu.cn/share/base/form/shrcnX8MRiwL8DAksin7t85XjUd) |
| 产品功能 | [API 广场](https://open.chineselaw.com/api-square) · [MCP Server](https://open.chineselaw.com/mcp-config) · [接口文档](https://open.chineselaw.com/docs) · [新站福利](https://open.chineselaw.com/activity) |
| 元典生态 | [元典智库](https://www.chineselaw.com) · [元典 Amicus](https://ami.ailaw.cn) · [元典脱敏](https://tuomin.ailaw.cn) · [法律元力](https://yuanli.ailaw.cn) |
