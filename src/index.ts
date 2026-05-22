#!/usr/bin/env node
import type { Readable, Writable } from 'node:stream';

import type { CallToolResult, JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { McpServer, ReadBuffer, serializeMessage } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const DEFAULT_CATALOG_URLS = [
    'https://apiplatform.legalmind.cn/api/apis?categoryId=7&keyword=&sortBy=latest&pageNum=1&pageSize=12',
    'https://apiplatform.legalmind.cn/api/apis?categoryId=6&keyword=&sortBy=latest&pageNum=1&pageSize=12',
    'https://apiplatform.legalmind.cn/api/apis?categoryId=9&keyword=&sortBy=latest&pageNum=1&pageSize=50'
];

const API_PLATFORM_ORIGIN = 'https://apiplatform.legalmind.cn';
const DEFAULT_OPEN_API_BASE = 'https://open.chineselaw.com/open';
const SERVER_VERSION = '0.1.3';

interface ApiCatalogResponse {
    code: number;
    message?: string;
    data?: {
        list?: ApiSummary[];
    };
}

interface ApiDetailResponse {
    code: number;
    message?: string;
    data?: ApiDetail;
}

interface ApiSummary {
    id: number;
    name: string;
    categoryId?: number;
    categoryName?: string;
    description?: string;
    httpMethod?: string;
    routeKey?: string;
    updatedAt?: string;
}

interface ApiDetail extends ApiSummary {
    requestParams?: string;
    responseParams?: string;
    requestExample?: unknown;
    responseExample?: unknown;
    fullDocument?: string;
}

interface ApiDefinition extends ApiDetail {
    endpoint: string;
    toolName: string;
}

interface ParameterSpec {
    name: string;
    type: string;
    required: boolean;
    description: string;
}

class StdioServerTransport implements Transport {
    private readBuffer = new ReadBuffer();
    private started = false;
    private closed = false;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(
        private stdin: Readable = process.stdin,
        private stdout: Writable = process.stdout
    ) {}

    private onData = (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
    };

    private onError = (error: Error) => {
        this.onerror?.(error);
    };

    private onStdoutError = (error: Error) => {
        this.onerror?.(error);
        this.close().catch(() => {
            // Already handling an output error; close failures do not add useful signal here.
        });
    };

    async start(): Promise<void> {
        if (this.started) {
            throw new Error('StdioServerTransport already started.');
        }

        this.started = true;
        this.stdin.on('data', this.onData);
        this.stdin.on('error', this.onError);
        this.stdout.on('error', this.onStdoutError);
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.stdin.off('data', this.onData);
        this.stdin.off('error', this.onError);
        this.stdout.off('error', this.onStdoutError);

        if (this.stdin.listenerCount('data') === 0) {
            this.stdin.pause();
        }

        this.readBuffer.clear();
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.closed) {
            throw new Error('StdioServerTransport is closed');
        }

        const json = serializeMessage(message);
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onError = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.stdout.off('error', onError);
                this.stdout.off('drain', onDrain);
                reject(error);
            };
            const onDrain = () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.stdout.off('error', onError);
                this.stdout.off('drain', onDrain);
                resolve();
            };

            this.stdout.once('error', onError);
            if (this.stdout.write(json)) {
                if (settled) {
                    return;
                }
                settled = true;
                this.stdout.off('error', onError);
                resolve();
            } else {
                this.stdout.once('drain', onDrain);
            }
        });
    }

    private processReadBuffer(): void {
        while (true) {
            try {
                const message = this.readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }
}

function getCatalogUrls(): string[] {
    const envValue = process.env.YUANDIAN_CATALOG_URLS;
    if (!envValue) {
        return DEFAULT_CATALOG_URLS;
    }

    const urls = envValue
        .split(/[,\n]/)
        .map(url => url.trim())
        .filter(Boolean);

    return urls.length > 0 ? urls : DEFAULT_CATALOG_URLS;
}

function getOpenApiBase(): string {
    return (process.env.YUANDIAN_OPEN_API_BASE || DEFAULT_OPEN_API_BASE).replace(/\/+$/, '');
}

function getApiKey(): string {
    const apiKey = process.env.YUANDIAN_API_KEY;
    if (!apiKey) {
        throw new Error('Missing API key. Set YUANDIAN_API_KEY before calling 元典 tools.');
    }

    return apiKey;
}

function getTimeoutMs(): number {
    const value = Number(process.env.YUANDIAN_API_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : 60_000;
}

function getMaxTextChars(): number {
    const value = Number(process.env.YUANDIAN_MAX_TEXT_CHARS);
    return Number.isFinite(value) && value > 0 ? value : 24_000;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
    }
    if (!headers.has('User-Agent')) {
        headers.set('User-Agent', `yuandian-mcp-server/${SERVER_VERSION}`);
    }

    const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(getTimeoutMs())
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(text, 1_000)}`);
    }

    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new Error(`Failed to parse JSON from ${url}: ${String(error)}; body=${truncate(text, 1_000)}`);
    }
}

async function discoverApis(): Promise<ApiDefinition[]> {
    const catalogResponses = await Promise.all(
        getCatalogUrls().map(async url => {
            const catalog = await fetchJson<ApiCatalogResponse>(url);
            if (catalog.code !== 200) {
                throw new Error(`Catalog request failed for ${url}: ${catalog.message ?? catalog.code}`);
            }

            return catalog.data?.list ?? [];
        })
    );

    const summariesById = new Map<number, ApiSummary>();
    for (const summary of catalogResponses.flat()) {
        if (typeof summary.id === 'number') {
            summariesById.set(summary.id, summary);
        }
    }

    const openApiBase = getOpenApiBase();
    const details = await Promise.all(
        [...summariesById.values()].map(async summary => {
            try {
                const detail = await fetchApiDetail(summary.id);
                return {
                    ...summary,
                    ...detail,
                    endpoint: `${openApiBase}/${detail.routeKey || summary.routeKey}`,
                    toolName: ''
                };
            } catch (error) {
                console.error(`Failed to fetch API detail for id=${summary.id}:`, error);
                return {
                    ...summary,
                    endpoint: `${openApiBase}/${summary.routeKey}`,
                    toolName: ''
                };
            }
        })
    );

    const usedToolNames = new Map<string, number>();
    return details
        .filter(api => api.routeKey)
        .map(api => {
            const baseToolName = sanitizeToolName(`yuandian_${api.routeKey}`);
            const nextCount = usedToolNames.get(baseToolName) ?? 0;
            usedToolNames.set(baseToolName, nextCount + 1);

            return {
                ...api,
                toolName: nextCount === 0 ? baseToolName : sanitizeToolName(`${baseToolName}_${api.id}`)
            };
        });
}

async function fetchApiDetail(id: number): Promise<ApiDetail> {
    const detail = await fetchJson<ApiDetailResponse>(`${API_PLATFORM_ORIGIN}/api/apis/${id}`);
    if (detail.code !== 200 || !detail.data) {
        throw new Error(`API detail request failed for id=${id}: ${detail.message ?? detail.code}`);
    }

    return detail.data;
}

function registerDynamicApiTools(server: McpServer, apis: ApiDefinition[]): void {
    for (const api of apis) {
        server.registerTool(
            api.toolName,
            {
                title: api.name,
                description: buildToolDescription(api),
                inputSchema: buildInputSchema(api)
            },
            async (params: Record<string, unknown>): Promise<CallToolResult> => {
                try {
                    const result = await callOpenApi(api, params as Record<string, unknown>);
                    return openApiResultToToolResult(result);
                } catch (error) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: error instanceof Error ? error.message : String(error)
                            }
                        ]
                    };
                }
            }
        );
    }
}

function registerHelperTools(server: McpServer, apis: ApiDefinition[]): void {
    server.registerTool(
        'yuandian_list_apis',
        {
            title: '元典接口清单',
            description: '列出当前 MCP Server 启动时从元典开放平台目录动态发现的接口。',
            inputSchema: z.object({
                categoryId: z.number().optional().describe('可选分类 ID：法律法规=7，案例文书=6，企业信息=9'),
                keyword: z.string().optional().describe('按接口名称、routeKey 或描述做本地关键词过滤')
            })
        },
        async (params: { categoryId?: number; keyword?: string }): Promise<CallToolResult> => {
            const { categoryId, keyword } = params;
            const normalizedKeyword = keyword?.trim().toLowerCase();
            const filtered = apis.filter(api => {
                if (categoryId !== undefined && api.categoryId !== categoryId) {
                    return false;
                }
                if (!normalizedKeyword) {
                    return true;
                }

                return [api.name, api.routeKey, api.description, api.categoryName]
                    .filter(Boolean)
                    .some(value => value!.toLowerCase().includes(normalizedKeyword));
            });

            const output = {
                total: filtered.length,
                apis: filtered.map(toPublicApiInfo)
            };

            return jsonToolResult(output);
        }
    );

    server.registerTool(
        'yuandian_get_api_document',
        {
            title: '元典接口文档',
            description: '根据接口 id、routeKey 或 MCP toolName 获取元典开放平台 Markdown 接口文档。',
            inputSchema: z.object({
                id: z.number().optional().describe('接口 ID'),
                routeKey: z.string().optional().describe('接口 routeKey'),
                toolName: z.string().optional().describe('MCP tool 名称，例如 yuandian_rh_enterpriseSearch')
            })
        },
        async (params: { id?: number; routeKey?: string; toolName?: string }): Promise<CallToolResult> => {
            const { id, routeKey, toolName } = params;
            const api = apis.find(candidate => {
                return (
                    (id !== undefined && candidate.id === id) ||
                    (routeKey !== undefined && candidate.routeKey === routeKey) ||
                    (toolName !== undefined && candidate.toolName === toolName)
                );
            });

            if (!api) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: '未找到匹配接口，请提供 id、routeKey 或 toolName。'
                        }
                    ]
                };
            }

            const latestDetail = await fetchApiDetail(api.id);
            const document = latestDetail.fullDocument || latestDetail.requestParams || api.description || '';
            const output = {
                ...toPublicApiInfo({ ...api, ...latestDetail }),
                requestParams: latestDetail.requestParams,
                responseParams: latestDetail.responseParams,
                requestExample: latestDetail.requestExample,
                responseExample: latestDetail.responseExample,
                fullDocument: document
            };

            return {
                content: [{ type: 'text', text: document || JSON.stringify(output, null, 2) }],
                structuredContent: output
            };
        }
    );
}

function buildToolDescription(api: ApiDefinition): string {
    return [
        `${api.categoryName || '元典开放平台'} - ${api.name}`,
        api.description,
        `HTTP ${api.httpMethod || 'GET'} ${api.endpoint}`,
        `接口文档: ${API_PLATFORM_ORIGIN}/api/apis/${api.id}`,
        '未在 schema 中精确建模的参数也可以直接传入。'
    ]
        .filter(Boolean)
        .join('\n');
}

function buildInputSchema(api: ApiDetail): z.ZodObject<Record<string, z.ZodType>> {
    const params = parseRequestParams(api.requestParams);
    const shape: Record<string, z.ZodType> = {};

    for (const param of params) {
        shape[param.name] = zodSchemaForParam(param);
    }

    return z.object(shape).catchall(z.unknown());
}

function parseRequestParams(markdown?: string): ParameterSpec[] {
    if (!markdown) {
        return [];
    }

    const lines = markdown.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const headerCells = parseTableCells(lines[index]);
        if (headerCells.length === 0) {
            continue;
        }

        const fieldIndex = findHeaderIndex(headerCells, ['字段名', '参数名', '参数']);
        const typeIndex = findHeaderIndex(headerCells, ['类型']);
        const requiredIndex = findHeaderIndex(headerCells, ['是否必填', '必填', 'required']);
        const descriptionIndex = findHeaderIndex(headerCells, ['说明', '描述']);

        if (fieldIndex < 0 || typeIndex < 0) {
            continue;
        }

        const params: ParameterSpec[] = [];
        let rowIndex = index + 1;
        if (rowIndex < lines.length && isSeparatorRow(lines[rowIndex])) {
            rowIndex++;
        }

        for (; rowIndex < lines.length; rowIndex++) {
            const rowCells = parseTableCells(lines[rowIndex]);
            if (rowCells.length === 0) {
                break;
            }
            if (isSeparatorCells(rowCells)) {
                continue;
            }

            const name = extractFieldName(rowCells[fieldIndex]);
            if (!name) {
                continue;
            }

            params.push({
                name,
                type: cleanCell(rowCells[typeIndex] ?? 'string'),
                required: requiredIndex >= 0 ? isRequired(rowCells[requiredIndex]) : false,
                description: descriptionIndex >= 0 ? cleanCell(rowCells[descriptionIndex] ?? '') : ''
            });
        }

        return params;
    }

    return [];
}

function parseTableCells(line: string | undefined): string[] {
    if (!line) {
        return [];
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
        return [];
    }

    return trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
}

function findHeaderIndex(cells: string[], candidates: string[]): number {
    return cells.findIndex(cell => {
        const normalized = normalizeHeader(cell);
        return candidates.some(candidate => normalized.includes(normalizeHeader(candidate)));
    });
}

function normalizeHeader(value: string): string {
    return cleanCell(value).replace(/\s+/g, '').toLowerCase();
}

function isSeparatorRow(line: string): boolean {
    return isSeparatorCells(parseTableCells(line));
}

function isSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function extractFieldName(cell: string | undefined): string {
    if (!cell) {
        return '';
    }

    const codeMatch = cell.match(/`([^`]+)`/);
    const value = codeMatch?.[1] ?? cleanCell(cell);
    return value.replace(/^["']|["']$/g, '').trim();
}

function cleanCell(value: string): string {
    return value
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*/g, '')
        .replace(/\\([`*_{}\[\]()#+\-.!>])/g, '$1')
        .trim();
}

function isRequired(cell: string): boolean {
    const value = cleanCell(cell).toLowerCase();
    if (/否|可选|false|no/.test(value)) {
        return false;
    }

    return /是|必填|required|true|yes/.test(value);
}

function zodSchemaForParam(param: ParameterSpec): z.ZodType {
    let schema: z.ZodType;
    const type = param.type.toLowerCase();

    if (/\[\]|array|list|数组/.test(type)) {
        if (/int|integer|long|float|double|number|decimal|numeric|数值|数字/.test(type)) {
            schema = z.array(z.number());
        } else if (/bool|boolean|布尔/.test(type)) {
            schema = z.array(z.boolean());
        } else if (/object|map|dict|json|对象/.test(type)) {
            schema = z.array(z.record(z.string(), z.unknown()));
        } else {
            schema = z.array(z.string());
        }
    } else if (/bool|boolean|布尔/.test(type)) {
        schema = z.boolean();
    } else if (/int|integer|long|float|double|number|decimal|numeric|数值|数字/.test(type)) {
        schema = z.number();
    } else if (/object|map|dict|json|对象/.test(type)) {
        schema = z.record(z.string(), z.unknown());
    } else {
        schema = z.string();
    }

    if (param.description) {
        schema = schema.describe(param.description);
    }

    return param.required ? schema : schema.optional();
}

async function callOpenApi(api: ApiDefinition, params: Record<string, unknown>): Promise<unknown> {
    const method = (api.httpMethod || 'GET').toUpperCase();
    const headers = new Headers({
        Accept: 'application/json',
        'X-API-Key': getApiKey(),
        'User-Agent': `yuandian-mcp-server/${SERVER_VERSION}`
    });

    const endpoint = new URL(api.endpoint);
    const requestInit: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(getTimeoutMs())
    };

    if (method === 'GET') {
        appendSearchParams(endpoint, params);
    } else {
        headers.set('Content-Type', 'application/json; charset=utf-8');
        requestInit.body = JSON.stringify(params);
    }

    const response = await fetch(endpoint, requestInit);
    const text = await response.text();

    let data: unknown = text;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(toJsonText(data), 2_000)}`);
    }

    return data;
}

function appendSearchParams(url: URL, params: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                url.searchParams.append(key, stringifyQueryValue(item));
            }
            continue;
        }

        url.searchParams.set(key, stringifyQueryValue(value));
    }
}

function stringifyQueryValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    return JSON.stringify(value);
}

function openApiResultToToolResult(data: unknown): CallToolResult {
    return {
        isError: isBusinessError(data),
        content: [{ type: 'text', text: truncate(toJsonText(data), getMaxTextChars()) }],
        structuredContent: toStructuredContent(data)
    };
}

function jsonToolResult(data: Record<string, unknown>): CallToolResult {
    return {
        content: [{ type: 'text', text: truncate(toJsonText(data), getMaxTextChars()) }],
        structuredContent: data
    };
}

function isBusinessError(data: unknown): boolean {
    if (!isRecord(data)) {
        return false;
    }

    const code = data.code;
    if (typeof code === 'number') {
        return code !== 200 && code !== 201;
    }

    const status = data.status;
    if (typeof status === 'string') {
        return ['failed', 'error', 'notfound'].includes(status.toLowerCase());
    }

    return false;
}

function toStructuredContent(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : { data: value };
}

function toPublicApiInfo(api: ApiDefinition | ApiDetail): Record<string, unknown> {
    const routeKey = api.routeKey || '';
    return {
        id: api.id,
        name: api.name,
        categoryId: api.categoryId,
        categoryName: api.categoryName,
        description: api.description,
        httpMethod: api.httpMethod,
        routeKey,
        toolName: 'toolName' in api ? api.toolName : sanitizeToolName(`yuandian_${routeKey}`),
        endpoint: 'endpoint' in api ? api.endpoint : `${getOpenApiBase()}/${routeKey}`,
        updatedAt: api.updatedAt,
        docsUrl: `${API_PLATFORM_ORIGIN}/api/apis/${api.id}`
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, maxChars)}\n... truncated ${value.length - maxChars} chars`;
}

function sanitizeToolName(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[-.]+|[-.]+$/g, '');
    return (sanitized || 'yuandian_api').slice(0, 128);
}

async function main(): Promise<void> {
    const apis = await discoverApis();
    const server = new McpServer({
        name: 'yuandian-mcp-server',
        version: SERVER_VERSION
    });

    registerHelperTools(server, apis);
    registerDynamicApiTools(server, apis);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`元典开放平台 MCP Server running on stdio with ${apis.length} dynamic API tools.`);
}

main().catch(error => {
    console.error('Fatal error in 元典 MCP server:', error);
    process.exit(1);
});
