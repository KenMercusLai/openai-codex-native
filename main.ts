import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const PROVIDER_ID = 'openai-codex-native';
const PROVIDER_NAME = 'OpenAI Codex (Native)';
const PROVIDER_DESCRIPTION = 'Use the local codex CLI app-server as an Alma provider';
const CODEX_BINARY = '/opt/homebrew/bin/codex';
const CODEX_AUTH_PATH = `${process.env.HOME ?? ''}/.codex/auth.json`;
const MODELS_CACHE_PATH = `${process.env.HOME ?? ''}/.codex/models_cache.json`;
const BASE_URL = 'http://openai-codex-native.local/v1';
const DUMMY_API_KEY = 'codex-native';
const DEFAULT_CWD = '/tmp';
const DEFAULT_APPROVAL_POLICY = 'never';
const DEFAULT_SANDBOX = 'read-only';
const CLIENT_INFO = {
    name: 'alma',
    title: 'Alma',
    version: '1.0.0',
} as const;
const REASONING_SUFFIXES = ['xhigh', 'high', 'medium', 'low', 'minimal'] as const;

type Logger = {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
};

type Disposable = { dispose(): void };

type PluginContext = {
    logger: Logger;
    providers: { register(provider: AlmaProvider): Disposable };
    commands: { register(id: string, handler: () => unknown | Promise<unknown>): Disposable };
    ui: {
        showNotification(message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error' }): void;
        showError?(message: string): void;
    };
};

type PluginActivation = { dispose(): void };

type AlmaModel = {
    id: string;
    name: string;
    description?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    capabilities: {
        streaming: boolean;
        reasoning: boolean;
        functionCalling: boolean;
        vision?: boolean;
    };
    providerOptions?: Record<string, unknown>;
};

type AlmaProvider = {
    id: string;
    name: string;
    description: string;
    authType: 'none' | 'oauth';
    initialize(): Promise<void>;
    isAuthenticated(): Promise<boolean>;
    getModels(): Promise<AlmaModel[]>;
    fetchModels(): Promise<AlmaModel[]>;
    getSDKConfig(): Promise<{
        apiKey: string;
        baseURL: string;
        fetch: typeof globalThis.fetch;
        useResponsesAPI?: boolean;
    }>;
};

type JsonRpcPending = {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
};

type JsonRpcNotification = {
    method: string;
    params?: any;
};

type ModelCache = {
    models?: CachedModel[];
};

type CachedModel = {
    slug: string;
    display_name?: string;
    description?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{ effort?: string }>;
    context_window?: number;
    input_modalities?: string[];
    supported_in_api?: boolean;
    visibility?: string;
};

type OpenAIRequestBody = {
    model?: string;
    input?: any;
    messages?: any[];
    instructions?: string;
    tools?: any[];
    tool_choice?: any;
    text?: {
        format?: {
            type?: string;
            schema?: Record<string, unknown>;
        };
    };
    response_format?: {
        type?: string;
        json_schema?: {
            schema?: Record<string, unknown>;
        };
    };
    reasoning?: {
        effort?: string;
    };
    stream?: boolean;
};

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
};

type CodexUserInput =
    | { type: 'text'; text: string; text_elements: any[] }
    | { type: 'image'; url: string }
    | { type: 'localImage'; path: string };

class CodexAppServerClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private startPromise: Promise<void> | null = null;
    private nextId = 1;
    private buffer = '';
    private pending = new Map<number, JsonRpcPending>();
    private listeners = new Set<(message: JsonRpcNotification) => void>();
    private disposed = false;

    constructor(private readonly logger: Logger) {}

    async ensureStarted(): Promise<void> {
        if (this.disposed) {
            throw new Error('Codex client already disposed');
        }
        if (!this.startPromise) {
            this.startPromise = this.start().catch((error) => {
                this.startPromise = null;
                throw error;
            });
        }
        await this.startPromise;
    }

    async request(method: string, params?: any): Promise<any> {
        await this.ensureStarted();
        return this.requestInternal(method, params);
    }

    addListener(listener: (message: JsonRpcNotification) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async restart(): Promise<void> {
        await this.dispose();
        this.disposed = false;
        await this.ensureStarted();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.startPromise = null;
        const pendingError = new Error('Codex app-server disposed');
        for (const pending of this.pending.values()) {
            pending.reject(pendingError);
        }
        this.pending.clear();
        if (this.child) {
            this.child.kill('SIGTERM');
            this.child = null;
        }
        this.buffer = '';
    }

    private async start(): Promise<void> {
        this.spawnChild();
        await this.requestInternal('initialize', {
            clientInfo: CLIENT_INFO,
            capabilities: {
                experimentalApi: true,
            },
        });
        this.send({
            method: 'initialized',
        });
        this.logger.info('Codex app-server initialized');
    }

    private spawnChild(): void {
        if (this.child) {
            return;
        }

        if (!existsSync(CODEX_BINARY)) {
            throw new Error(`Codex binary not found at ${CODEX_BINARY}`);
        }

        this.child = spawn(CODEX_BINARY, ['app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child.stdout.on('data', (chunk: Buffer) => {
            this.consumeStdout(chunk.toString('utf8'));
        });

        this.child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                this.logger.debug?.(`[codex stderr] ${text}`);
            }
        });

        this.child.on('error', (error: Error) => {
            this.logger.error('Failed to start codex app-server', error);
        });

        this.child.on('exit', (code: number | null, signal: string | null) => {
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            this.logger.warn(message);
            this.child = null;
            this.startPromise = null;
            this.buffer = '';
            const error = new Error(message);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();
        });
    }

    private consumeStdout(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line) {
                this.handleLine(line);
            }
            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    private handleLine(line: string): void {
        let message: any;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this.logger.warn('Skipping malformed codex JSON-RPC line', line, error);
            return;
        }

        if (typeof message.id === 'number' && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (typeof message.id === 'number' && typeof message.method === 'string') {
            void this.handleServerRequest(message);
            return;
        }

        if (typeof message.method === 'string') {
            for (const listener of this.listeners) {
                listener(message);
            }
        }
    }

    private async handleServerRequest(message: { id: number; method: string; params?: any }): Promise<void> {
        try {
            let result: any;
            switch (message.method) {
                case 'item/tool/call':
                    result = {
                        contentItems: [
                            {
                                type: 'inputText',
                                text: 'Dynamic tool execution is not directly bridged yet. Return control to Alma.',
                            },
                        ],
                        success: false,
                    };
                    break;
                case 'item/commandExecution/requestApproval':
                case 'item/fileChange/requestApproval':
                    result = { decision: 'decline' };
                    break;
                case 'item/permissions/requestApproval':
                    result = { permissions: {}, scope: 'turn' };
                    break;
                case 'item/tool/requestUserInput':
                    result = { answers: {} };
                    break;
                case 'mcpServer/elicitation/request':
                    result = { action: 'decline' };
                    break;
                case 'account/chatgptAuthTokens/refresh':
                    result = await readCodexAuthRefresh();
                    break;
                default:
                    result = { decision: 'decline' };
                    break;
            }

            this.send({
                id: message.id,
                result,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.send({
                id: message.id,
                error: {
                    code: -1,
                    message: err.message,
                },
            });
        }
    }

    private requestInternal(method: string, params?: any): Promise<any> {
        if (!this.child || this.child.stdin.destroyed) {
            throw new Error('Codex app-server is not running');
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({
                id,
                method,
                params,
            });
        });
    }

    private send(message: Record<string, unknown>): void {
        if (!this.child || this.child.stdin.destroyed) {
            throw new Error('Codex app-server stdin is unavailable');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
}

class CodexNativeRuntime {
    private readonly client: CodexAppServerClient;
    private readonly fetchImpl: typeof globalThis.fetch;
    private operationChain: Promise<unknown> = Promise.resolve();

    constructor(private readonly logger: Logger) {
        this.client = new CodexAppServerClient(logger);
        this.fetchImpl = this.createFetch();
    }

    async initialize(): Promise<void> {
        await this.client.ensureStarted();
    }

    async isAuthenticated(): Promise<boolean> {
        try {
            const auth = await readCodexAuthRefresh();
            return Boolean(auth.accessToken && auth.chatgptAccountId);
        } catch {
            return false;
        }
    }

    async getModels(): Promise<AlmaModel[]> {
        return readCachedModels();
    }

    async fetchModels(): Promise<AlmaModel[]> {
        try {
            const result = await this.client.request('model/list', {
                limit: null,
                cursor: null,
                includeHidden: null,
            });
            const models = Array.isArray(result?.data)
                ? buildAlmaModelsFromRpc(result.data)
                : [];

            if (models.length > 0) {
                return models;
            }
        } catch (error) {
            this.logger.warn('Falling back to cached models after model/list failure', error);
        }

        return this.getModels();
    }

    getFetch(): typeof globalThis.fetch {
        return this.fetchImpl;
    }

    async restart(): Promise<void> {
        await this.client.restart();
    }

    async dispose(): Promise<void> {
        await this.client.dispose();
    }

    private createFetch(): typeof globalThis.fetch {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = await resolveRequestUrl(input);
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

            if (url.pathname.endsWith('/models') && method.toUpperCase() === 'GET') {
                const models = await this.fetchModels();
                return jsonResponse({
                    object: 'list',
                    data: models,
                });
            }

            if (!url.pathname.endsWith('/responses')) {
                return jsonResponse(
                    {
                        error: {
                            message: `Unsupported endpoint: ${url.pathname}`,
                            type: 'invalid_request_error',
                        },
                    },
                    404,
                );
            }

            const bodyText = await readRequestBody(input, init);
            let requestBody: OpenAIRequestBody;
            try {
                requestBody = bodyText ? JSON.parse(bodyText) as OpenAIRequestBody : {};
            } catch (error) {
                return jsonResponse(
                    {
                        error: {
                            message: `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`,
                            type: 'invalid_request_error',
                        },
                    },
                    400,
                );
            }

            const wantsStreaming = requestBody.stream === true;

            const streamingResponse = await this.enqueue(() => this.handleResponsesRequest(requestBody));
            if (wantsStreaming) {
                return streamingResponse;
            }

            return convertSseToJson(streamingResponse);
        };
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const run = this.operationChain.then(work, work);
        this.operationChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async handleResponsesRequest(body: OpenAIRequestBody): Promise<Response> {
        await this.client.ensureStarted();

        const toolDefinitions = parseToolDefinitions(body.tools);
        const responseId = `resp_${compactId()}`;
        const messageId = `msg_${compactId()}`;
        const prepared = preparePrompt(body, toolDefinitions);

        const modelSpec = resolveModelSpec(body.model, body.reasoning?.effort);
        const thread = await this.client.request('thread/start', {
            model: modelSpec.baseModel,
            modelProvider: 'openai',
            cwd: DEFAULT_CWD,
            approvalPolicy: DEFAULT_APPROVAL_POLICY,
            sandbox: DEFAULT_SANDBOX,
            serviceName: 'Alma',
            developerInstructions: prepared.developerInstructions,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
        });

        const encoder = new TextEncoder();
        const turnState = {
            threadId: String(thread?.thread?.id ?? ''),
            turnId: '',
            fullText: '',
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
            completed: false,
        };

        if (!turnState.threadId) {
            throw new Error('thread/start did not return a thread id');
        }

        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                const push = (event: unknown) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                };

                push(buildResponseCreatedEvent(responseId, body.model ?? modelSpec.displayModel));

                let outputInitialized = false;
                const ensureOutputStarted = () => {
                    if (outputInitialized) {
                        return;
                    }
                    outputInitialized = true;
                    push(buildOutputItemAddedEvent(messageId));
                    push(buildContentPartAddedEvent());
                };

                const finishAsText = () => {
                    ensureOutputStarted();
                    push(buildOutputTextDoneEvent(turnState.fullText));
                    push(buildContentPartDoneEvent(turnState.fullText));
                    push(buildOutputItemDoneEvent(messageId, turnState.fullText));
                    push(buildResponseCompletedEvent(responseId, body.model ?? modelSpec.displayModel, [
                        {
                            type: 'message',
                            id: messageId,
                            role: 'assistant',
                            content: [{ type: 'output_text', text: turnState.fullText, annotations: [] }],
                            status: 'completed',
                        },
                    ], turnState.usage));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                };

                const unsubscribe = this.client.addListener((message) => {
                    const params = message.params ?? {};
                    const threadId = params.threadId;
                    const turnId = params.turnId ?? params.turn?.id;

                    if (threadId && threadId !== turnState.threadId) {
                        return;
                    }

                    if (turnState.turnId && turnId && turnId !== turnState.turnId) {
                        return;
                    }

                    switch (message.method) {
                        case 'item/agentMessage/delta': {
                            ensureOutputStarted();
                            const delta = String(params.delta ?? '');
                            turnState.fullText += delta;
                            push(buildOutputTextDeltaEvent(delta));
                            break;
                        }
                        case 'item/completed': {
                            const item = params.item;
                            if (item?.type === 'agentMessage' && typeof item.text === 'string') {
                                turnState.fullText = item.text;
                            }
                            break;
                        }
                        case 'thread/tokenUsage/updated': {
                            const last = params.tokenUsage?.last;
                            if (last) {
                                turnState.usage = {
                                    input_tokens: Number(last.inputTokens ?? 0),
                                    output_tokens: Number(last.outputTokens ?? 0),
                                    total_tokens: Number(last.totalTokens ?? 0),
                                };
                            }
                            break;
                        }
                        case 'turn/completed': {
                            if (turnState.completed) {
                                return;
                            }
                            turnState.completed = true;
                            unsubscribe();
                            finishAsText();
                            break;
                        }
                    }
                });

                try {
                    const turn = await this.client.request('turn/start', {
                        threadId: turnState.threadId,
                        input: prepared.userInput.length > 0
                            ? prepared.userInput
                            : [{ type: 'text', text: '[user]\nContinue.', text_elements: [] }],
                        cwd: DEFAULT_CWD,
                        approvalPolicy: DEFAULT_APPROVAL_POLICY,
                        model: modelSpec.baseModel,
                        effort: modelSpec.reasoningEffort,
                        outputSchema: prepared.outputSchema,
                    });
                    turnState.turnId = String(turn?.turn?.id ?? '');
                    if (!turnState.turnId) {
                        throw new Error('turn/start did not return a turn id');
                    }
                } catch (error) {
                    unsubscribe();
                    controller.error(error);
                }
            },
        });

        return new Response(stream, {
            status: 200,
            headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            },
        });
    }
}

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, providers, commands, ui } = context;
    const runtime = new CodexNativeRuntime(logger);

    logger.info('OpenAI Codex Native plugin activating...');

    const providerDisposable = providers.register({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        description: PROVIDER_DESCRIPTION,
        authType: 'none',

        async initialize() {
            await runtime.initialize();
        },

        async isAuthenticated() {
            return runtime.isAuthenticated();
        },

        async getModels() {
            return runtime.getModels();
        },

        async fetchModels() {
            return runtime.fetchModels();
        },

        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: BASE_URL,
                fetch: runtime.getFetch(),
                useResponsesAPI: true,
            };
        },
    });

    const statusCommand = commands.register('status', async () => {
        const isAuthenticated = await runtime.isAuthenticated();
        const models = await runtime.getModels();
        ui.showNotification(
            isAuthenticated
                ? `Codex native ready (${models.length} models cached)`
                : 'Codex native is not authenticated. Check ~/.codex/auth.json',
            { type: isAuthenticated ? 'success' : 'warning' },
        );
    });

    const restartCommand = commands.register('restart-server', async () => {
        await runtime.restart();
        ui.showNotification('Codex app-server restarted', { type: 'success' });
    });

    logger.info('OpenAI Codex Native plugin activated');

    return {
        dispose: () => {
            providerDisposable.dispose();
            statusCommand.dispose();
            restartCommand.dispose();
            void runtime.dispose();
            logger.info('OpenAI Codex Native plugin deactivated');
        },
    };
}

async function readCodexAuthRefresh(): Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string | null;
}> {
    const raw = await readFile(CODEX_AUTH_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
        tokens?: {
            access_token?: string;
            account_id?: string;
            id_token?: string;
        };
    };

    const accessToken = parsed.tokens?.access_token;
    const accountId = parsed.tokens?.account_id ?? extractAccountIdFromIdToken(parsed.tokens?.id_token);
    const planType = extractPlanTypeFromIdToken(parsed.tokens?.id_token);

    if (!accessToken || !accountId) {
        throw new Error(`Invalid Codex auth file at ${CODEX_AUTH_PATH}`);
    }

    return {
        accessToken,
        chatgptAccountId: accountId,
        chatgptPlanType: planType,
    };
}

async function readCachedModels(): Promise<AlmaModel[]> {
    try {
        const raw = await readFile(MODELS_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as ModelCache;
        const models = Array.isArray(parsed.models) ? buildAlmaModelsFromCache(parsed.models) : [];
        if (models.length > 0) {
            return models;
        }
    } catch {
        // Fall through to defaults.
    }

    return buildAlmaModelsFromCache([
        {
            slug: 'gpt-5',
            display_name: 'gpt-5',
            description: 'Default GPT-5 model',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [
                { effort: 'minimal' },
                { effort: 'low' },
                { effort: 'medium' },
                { effort: 'high' },
            ],
            context_window: 272000,
            input_modalities: ['text', 'image'],
            supported_in_api: true,
            visibility: 'list',
        },
    ]);
}

function buildAlmaModelsFromCache(models: CachedModel[]): AlmaModel[] {
    const result: AlmaModel[] = [];

    for (const model of models) {
        if (!model.slug) {
            continue;
        }
        if (model.supported_in_api === false) {
            continue;
        }
        if (model.visibility === 'hidden') {
            continue;
        }

        const supported = model.supported_reasoning_levels
            ?.map((entry) => entry.effort)
            .filter((effort): effort is string => Boolean(effort))
            ?? ['medium'];
        const defaultEffort = model.default_reasoning_level ?? supported[0] ?? 'medium';
        const displayName = model.display_name ?? model.slug;
        const description = model.description ?? displayName;
        const vision = Boolean(model.input_modalities?.includes('image'));

        result.push(makeAlmaModel(model.slug, displayName, description, defaultEffort, false, vision, model.context_window));

        for (const effort of supported) {
            if (effort === defaultEffort) {
                continue;
            }
            result.push(
                makeAlmaModel(
                    `${model.slug}-${effort}`,
                    `${displayName} (${capitalizeReasoning(effort)} Reasoning)`,
                    description,
                    effort,
                    false,
                    vision,
                    model.context_window,
                    model.slug,
                ),
            );
        }
    }

    return result.sort((left, right) => left.id.localeCompare(right.id));
}

function buildAlmaModelsFromRpc(models: any[]): AlmaModel[] {
    return buildAlmaModelsFromCache(
        models.map((model) => ({
            slug: model.model ?? model.id,
            display_name: model.displayName ?? model.model ?? model.id,
            description: model.description ?? model.displayName ?? model.model,
            default_reasoning_level: model.defaultReasoningEffort,
            supported_reasoning_levels: Array.isArray(model.supportedReasoningEfforts)
                ? model.supportedReasoningEfforts.map((entry: any) => ({ effort: entry.reasoningEffort }))
                : undefined,
            context_window: model.contextWindow,
            input_modalities: Array.isArray(model.inputModalities) ? model.inputModalities : undefined,
            supported_in_api: !model.hidden,
            visibility: model.hidden ? 'hidden' : 'list',
        })),
    );
}

function makeAlmaModel(
    modelId: string,
    name: string,
    description: string,
    reasoningEffort: string,
    functionCalling: boolean,
    vision: boolean,
    contextWindow?: number,
    baseModel?: string,
): AlmaModel {
    return {
        id: modelId,
        name,
        description,
        contextWindow,
        capabilities: {
            streaming: true,
            reasoning: reasoningEffort !== 'none',
            functionCalling,
            vision,
        },
        providerOptions: {
            baseModel: baseModel ?? stripReasoningSuffix(modelId),
            reasoning: reasoningEffort,
        },
    };
}

function resolveModelSpec(modelId: string | undefined, requestEffort?: string): {
    baseModel: string;
    reasoningEffort: string | undefined;
    displayModel: string;
} {
    const requestedModel = modelId ?? 'gpt-5';
    const suffixMatch = REASONING_SUFFIXES.find((suffix) => requestedModel.endsWith(`-${suffix}`));
    const baseModel = suffixMatch ? requestedModel.slice(0, -1 * (`-${suffixMatch}`.length)) : requestedModel;
    const reasoningEffort = requestEffort ?? suffixMatch ?? undefined;

    return {
        baseModel,
        reasoningEffort,
        displayModel: requestedModel,
    };
}

function stripReasoningSuffix(modelId: string): string {
    const suffixMatch = REASONING_SUFFIXES.find((suffix) => modelId.endsWith(`-${suffix}`));
    return suffixMatch ? modelId.slice(0, -1 * (`-${suffixMatch}`.length)) : modelId;
}

function preparePrompt(
    body: OpenAIRequestBody,
    toolDefinitions: ToolDefinition[],
): {
    developerInstructions: string;
    userInput: CodexUserInput[];
    outputSchema: Record<string, unknown> | null;
} {
    const developerParts: string[] = [
        'You are responding inside Alma through the local Codex CLI app-server.',
        'Treat role labels in the incoming text items as the full stateless conversation transcript.',
    ];

    if (typeof body.instructions === 'string' && body.instructions.trim()) {
        developerParts.push(body.instructions.trim());
    }

    const userInput = normalizeOpenAIInput(body.input ?? body.messages, developerParts);
    let outputSchema = extractRequestedOutputSchema(body);

    if (toolDefinitions.length > 0) {
        developerParts.push(
            'The caller provided tool definitions, but this Alma Codex Native build does not execute or bridge tools yet.',
            'If a tool would be needed, explain the intended tool name and arguments in plain text instead of pretending it ran.',
            formatToolCatalog(toolDefinitions),
        );
    }

    return {
        developerInstructions: developerParts.join('\n\n'),
        userInput,
        outputSchema,
    };
}

function parseToolDefinitions(rawTools: any[] | undefined): ToolDefinition[] {
    if (!Array.isArray(rawTools)) {
        return [];
    }

    return rawTools
        .map((tool): ToolDefinition | null => {
            if (!tool || typeof tool !== 'object') {
                return null;
            }
            if (tool.type !== 'function') {
                return null;
            }

            const name = typeof tool.name === 'string' ? tool.name : typeof tool.function?.name === 'string' ? tool.function.name : '';
            if (!name) {
                return null;
            }

            const description = typeof tool.description === 'string'
                ? tool.description
                : typeof tool.function?.description === 'string'
                    ? tool.function.description
                    : '';

            const parameters = isRecord(tool.parameters)
                ? tool.parameters
                : isRecord(tool.function?.parameters)
                    ? tool.function.parameters
                    : { type: 'object', additionalProperties: true };

            return {
                name,
                description,
                parameters,
            };
        })
        .filter((tool): tool is ToolDefinition => Boolean(tool));
}

function normalizeOpenAIInput(rawInput: unknown, developerParts: string[]): CodexUserInput[] {
    const input = Array.isArray(rawInput) ? rawInput : rawInput == null ? [] : [rawInput];
    const result: CodexUserInput[] = [];

    for (const item of input) {
        appendNormalizedInput(item, result, developerParts);
    }

    return result;
}

function appendNormalizedInput(item: unknown, output: CodexUserInput[], developerParts: string[]): void {
    if (typeof item === 'string') {
        output.push(toTextInput(`[user]\n${item}`));
        return;
    }

    if (!isRecord(item)) {
        return;
    }

    const itemType = typeof item.type === 'string' ? item.type : '';
    const role = typeof item.role === 'string' ? item.role : 'user';

    if (itemType === 'message' || role in { user: true, assistant: true, system: true, developer: true, tool: true }) {
        appendMessageLikeInput(item, output, developerParts);
        return;
    }

    if (itemType === 'input_text' || itemType === 'output_text' || itemType === 'text') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
            output.push(toTextInput(`[user]\n${text}`));
        }
        return;
    }

    if (itemType === 'input_image') {
        const imageUrl = typeof item.image_url === 'string'
            ? item.image_url
            : typeof item.imageUrl === 'string'
                ? item.imageUrl
                : '';
        if (imageUrl) {
            output.push(toImageInput(imageUrl));
        }
        return;
    }

    if (itemType === 'function_call') {
        const name = typeof item.name === 'string' ? item.name : 'unknown_tool';
        const argumentsText = typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments ?? {});
        output.push(toTextInput(`[assistant tool call]\n${name}\n${argumentsText}`));
        return;
    }

    if (itemType === 'function_call_output') {
        const name = typeof item.name === 'string' ? item.name : 'tool';
        const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? {});
        output.push(toTextInput(`[tool result]\n${name}\n${text}`));
    }
}

function appendMessageLikeInput(item: Record<string, unknown>, output: CodexUserInput[], developerParts: string[]): void {
    const role = typeof item.role === 'string' ? item.role : 'user';
    const content = normalizeMessageContent(item.content);
    const textParts: string[] = [];

    for (const part of content) {
        if (part.type === 'text' && part.text) {
            textParts.push(part.text);
        } else if (part.type === 'image' && part.url) {
            output.push(toImageInput(part.url));
        }
    }

    if (textParts.length === 0) {
        return;
    }

    const text = textParts.join('\n');
    if (role === 'system' || role === 'developer') {
        developerParts.push(text);
    } else {
        output.push(toTextInput(`[${role}]\n${text}`));
    }
}

function normalizeMessageContent(content: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    const result: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [];

    for (const part of content) {
        if (typeof part === 'string') {
            result.push({ type: 'text', text: part });
            continue;
        }

        if (!isRecord(part)) {
            continue;
        }

        const type = typeof part.type === 'string' ? part.type : '';
        if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof part.text === 'string') {
            result.push({ type: 'text', text: part.text });
            continue;
        }

        if (type === 'input_image' || type === 'image_url' || type === 'image') {
            const url = typeof part.image_url === 'string'
                ? part.image_url
                : typeof part.imageUrl === 'string'
                    ? part.imageUrl
                    : typeof part.url === 'string'
                        ? part.url
                        : '';
            if (url) {
                result.push({ type: 'image', url });
            }
        }
    }

    return result;
}

function extractRequestedOutputSchema(body: OpenAIRequestBody): Record<string, unknown> | null {
    if (body.text?.format?.type === 'json_schema' && isRecord(body.text.format.schema)) {
        return body.text.format.schema;
    }

    if (body.response_format?.type === 'json_schema' && isRecord(body.response_format.json_schema?.schema)) {
        return body.response_format.json_schema.schema;
    }

    return null;
}

function formatToolCatalog(toolDefinitions: ToolDefinition[]): string {
    return [
        'Available tools:',
        ...toolDefinitions.map((tool) => `${tool.name}: ${tool.description || 'No description'}\n${JSON.stringify(tool.parameters)}`),
    ].join('\n\n');
}

function buildResponseCreatedEvent(responseId: string, model: string) {
    return {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            output: [],
            status: 'in_progress',
        },
    };
}

function buildOutputItemAddedEvent(messageId: string) {
    return {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
            type: 'message',
            id: messageId,
            role: 'assistant',
            content: [],
            status: 'in_progress',
        },
    };
}

function buildContentPartAddedEvent() {
    return {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: {
            type: 'output_text',
            text: '',
        },
    };
}

function buildOutputTextDeltaEvent(delta: string) {
    return {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta,
    };
}

function buildOutputTextDoneEvent(text: string) {
    return {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text,
    };
}

function buildContentPartDoneEvent(text: string) {
    return {
        type: 'response.content_part.done',
        output_index: 0,
        content_index: 0,
        part: {
            type: 'output_text',
            text,
        },
    };
}

function buildOutputItemDoneEvent(messageId: string, text: string) {
    return {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
            type: 'message',
            id: messageId,
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
            status: 'completed',
        },
    };
}

function buildResponseCompletedEvent(
    responseId: string,
    model: string,
    output: any[],
    usage: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
    },
) {
    return {
        type: 'response.completed',
        response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            output,
            status: 'completed',
            usage,
        },
    };
}

async function resolveRequestUrl(input: RequestInfo | URL): Promise<URL> {
    if (typeof input === 'string') {
        return new URL(input);
    }
    if (input instanceof URL) {
        return input;
    }
    return new URL(input.url);
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
    if (typeof init?.body === 'string') {
        return init.body;
    }

    if (init?.body instanceof Uint8Array) {
        return new TextDecoder().decode(init.body);
    }

    if (typeof input !== 'string' && !(input instanceof URL) && input instanceof Request) {
        return input.clone().text();
    }

    return '';
}

async function convertSseToJson(response: Response): Promise<Response> {
    if (!response.body) {
        return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        fullText += decoder.decode(value, { stream: true });
    }

    let finalResponse: unknown = null;
    for (const line of fullText.split('\n')) {
        if (!line.startsWith('data: ')) {
            continue;
        }
        const payload = line.slice(6);
        if (payload === '[DONE]') {
            continue;
        }
        try {
            const parsed = JSON.parse(payload);
            if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
                finalResponse = parsed.response;
            }
        } catch {
            // Ignore malformed SSE lines.
        }
    }

    if (finalResponse == null) {
        return response;
    }

    return new Response(JSON.stringify(finalResponse), {
        status: response.status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
        },
    });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
        },
    });
}

function toTextInput(text: string): CodexUserInput {
    return {
        type: 'text',
        text,
        text_elements: [],
    };
}

function toImageInput(url: string): CodexUserInput {
    if (url.startsWith('file://')) {
        return {
            type: 'localImage',
            path: url.slice('file://'.length),
        };
    }

    return {
        type: 'image',
        url,
    };
}

function compactId(): string {
    return randomUUID().replace(/-/g, '');
}

function extractAccountIdFromIdToken(idToken: string | undefined): string | null {
    const payload = decodeJwtPayload(idToken);
    const auth = isRecord(payload?.['https://api.openai.com/auth'])
        ? payload?.['https://api.openai.com/auth']
        : null;
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
}

function extractPlanTypeFromIdToken(idToken: string | undefined): string | null {
    const payload = decodeJwtPayload(idToken);
    const auth = isRecord(payload?.['https://api.openai.com/auth'])
        ? payload?.['https://api.openai.com/auth']
        : null;
    return typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null;
}

function decodeJwtPayload(token: string | undefined): Record<string, any> | null {
    if (!token) {
        return null;
    }
    const parts = token.split('.');
    if (parts.length < 2) {
        return null;
    }
    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
        const payload = Buffer.from(normalized + padding, 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function capitalizeReasoning(value: string): string {
    if (value === 'xhigh') {
        return 'XHigh';
    }
    return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
