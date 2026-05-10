/**
 * @fileoverview OpenAI 兼容 API 路由
 * @description 处理 /v1 路径下的所有 API 请求
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendJson, sendApiError } from '../../respond.js';
import { parseRequest, parseImagesRequest } from './parse.js';

/**
 * 创建 OpenAI API 路由处理器
 * @param {object} context - 路由上下文
 * @returns {Function} 路由处理函数
 */
export function createOpenAIRouter(context) {
    const {
        backendName,
        getModels,
        getImagePolicy,
        getModelType,
        tempDir,
        imageLimit,
        queueManager
    } = context;

    /**
     * 处理 GET /v1/models
     */
    function handleModels(res) {
        const models = getModels();
        sendJson(res, 200, models);
    }

    /**
     * 处理 GET /v1/cookies
     */
    async function handleCookies(res, requestId, workerName, domain) {
        const poolContext = queueManager.getPoolContext();

        if (!poolContext?.poolManager) {
            sendApiError(res, { code: ERROR_CODES.BROWSER_NOT_INITIALIZED });
            return;
        }

        try {
            const result = await queueManager.getWorkerCookies(workerName, domain);
            sendJson(res, 200, {
                worker: result.worker,
                cookies: result.cookies
            });
        } catch (err) {
            logger.error('服务器', '获取 Cookies 失败', { id: requestId, error: err.message });

            if (err.message.includes('Worker 不存在') || err.message.includes('Worker not found')) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_MODEL,
                    message: err.message
                });
            } else {
                sendApiError(res, {
                    code: ERROR_CODES.INTERNAL_ERROR,
                    message: err.message
                });
            }
        }
    }

    /**
     * 处理 POST /v1/chat/completions
     */
    async function handleChatCompletions(req, res, requestId) {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }

        try {
            const body = Buffer.concat(chunks).toString();
            const data = JSON.parse(body);
            const isStreaming = data.stream === true;

            // 限流检查
            if (!isStreaming && !queueManager.canAcceptNonStreaming()) {
                const status = queueManager.getStatus();
                logger.warn('服务器', '非流式请求被拒绝 (队列已满)', { id: requestId, queueSize: status.total });
                sendApiError(res, {
                    code: ERROR_CODES.SERVER_BUSY,
                    message: `服务器繁忙（队列: ${status.total}/${queueManager.maxQueueSize}）。请使用流式模式 (stream: true) 或稍后重试。`
                });
                return;
            }

            // 设置 SSE 响应头
            if (isStreaming) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
            }

            // 解析请求
            const parseResult = await parseRequest(data, {
                tempDir,
                imageLimit,
                backendName,
                getSupportedModels: getModels,
                getImagePolicy,
                getModelType,
                requestId,
                logger
            });

            if (!parseResult.success) {
                sendApiError(res, {
                    code: parseResult.error.code,
                    message: parseResult.error.error,
                    isStreaming
                });
                return;
            }

            const { prompt, imagePaths, modelId, modelName } = parseResult.data;
            const reasoning = data.reasoning === true;

            // 自动检测图片模型：当 modelId 的类型为 'image' 时，taskType 设为 'image'
            // 这样即使通过 /v1/chat/completions 调用，也能返回 Sub2API 兼容的 images 格式
            const modelType = getModelType ? getModelType(modelId) : 'image';
            const autoTaskType = modelType === 'image' ? 'image' : 'chat';

            logger.info('服务器', `[队列] 请求入队: ${prompt.slice(0, 100)}...`, { id: requestId, images: imagePaths.length });

            // 加入队列
            if (autoTaskType === 'image') {
                queueManager.addTask({
                    req,
                    res,
                    prompt,
                    imagePaths,
                    modelId,
                    modelName: modelName,
                    id: requestId,
                    isStreaming,
                    reasoning,
                    // 自动标记为 image 任务，走 images API 格式响应
                    taskType: 'image',
                    n: 1,
                    size: '1024x1024',
                    quality: 'auto',
                    responseFormat: 'b64_json'
                });
            } else {
                queueManager.addTask({
                    req,
                    res,
                    prompt,
                    imagePaths,
                    modelId,
                    modelName,
                    id: requestId,
                    isStreaming,
                    reasoning
                });
            }

        } catch (err) {
            logger.error('服务器', '请求处理失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    }

    /**
     * 处理 POST /v1/images/generations 或 /v1/images/edits
     */
    async function handleImagesGen(req, res, requestId, isEdit = false) {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }

        try {
            const body = Buffer.concat(chunks).toString();
            const data = JSON.parse(body);
            const isStreaming = data.stream === true;

            // 限流检查
            if (!isStreaming && !queueManager.canAcceptNonStreaming()) {
                const status = queueManager.getStatus();
                logger.warn('服务器', '[images] 非流式请求被拒绝 (队列已满)', { id: requestId, queueSize: status.total });
                sendApiError(res, {
                    code: ERROR_CODES.SERVER_BUSY,
                    message: `服务器繁忙（队列: ${status.total}/${queueManager.maxQueueSize}）。请使用流式模式 (stream: true) 或稍后重试。`
                });
                return;
            }

            // 设置 SSE 响应头
            if (isStreaming) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
            }

            // 解析 images 请求
            const parseResult = await parseImagesRequest(data, {
                tempDir,
                imageLimit,
                backendName,
                getSupportedModels: getModels,
                getImagePolicy,
                requestId,
                logger
            });

            if (!parseResult.success) {
                sendApiError(res, {
                    code: parseResult.error.code,
                    message: parseResult.error.error,
                    isStreaming
                });
                return;
            }

            const { prompt, imagePaths, modelId, modelName, size, quality, responseFormat, style } = parseResult.data;

            logger.info('服务器', `[队列][images] 生成请求入队: ${prompt.slice(0, 100)}...`, { id: requestId });

            // 加入队列（标记为 image 任务类型）
            queueManager.addTask({
                req,
                res,
                prompt,
                imagePaths,
                modelId,
                modelName: modelName,
                id: requestId,
                isStreaming,
                reasoning: false,
                taskType: 'image',
                // images API 特有参数
                n: 1,
                size: size || '1024x1024',
                quality: quality || 'auto',
                responseFormat: responseFormat || 'b64_json',
                style
            });

        } catch (err) {
            logger.error('服务器', '[images] 请求处理失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message,
                isStreaming: false
            });
        }
    }

    /**
     * OpenAI API 路由处理函数
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @param {string} pathname - 去除 /v1 前缀后的路径
     * @param {URL} parsedUrl - 解析后的 URL 对象
     */
    return async function handleOpenAIRequest(req, res, pathname, parsedUrl) {
        const requestId = crypto.randomUUID().slice(0, 8);

        if (req.method === 'GET' && pathname === '/models') {
            handleModels(res);
        } else if (req.method === 'GET' && pathname === '/cookies') {
            const workerName = parsedUrl.searchParams.get('name');
            const domain = parsedUrl.searchParams.get('domain');
            await handleCookies(res, requestId, workerName, domain);
        } else if (req.method === 'POST' && pathname.startsWith('/chat/completions')) {
            await handleChatCompletions(req, res, requestId);
        } else if (req.method === 'POST' && pathname === '/images/generations') {
            await handleImagesGen(req, res, requestId, false);
        } else if (req.method === 'POST' && pathname === '/images/edits') {
            await handleImagesGen(req, res, requestId, true);
        } else if (req.method === 'GET' && pathname.startsWith('/images/') && !pathname.startsWith('/images/generations') && !pathname.startsWith('/images/edits')) {
            // Fallback: images 下的所有 GET 请求 404
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'images API 不支持 GET', type: 'invalid_request_error' } }));
        } else {
            res.writeHead(404);
            res.end();
        }
    };
}
