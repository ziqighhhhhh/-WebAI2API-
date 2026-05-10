/**
 * @fileoverview 统一响应写出模块
 * @description 封装 JSON、SSE 响应和错误响应的统一处理函数
 */

import { getErrorDetails } from './errors.js';

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} payload - 响应数据
 */
export function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * 发送 SSE 事件
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} payload - 事件数据
 */
export function sendSse(res, payload) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 发送 SSE 结束标记
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 */
export function sendSseDone(res) {
    if (res.writableEnded) return;
    res.write(`data: [DONE]\n\n`);
    res.end();
}

/**
 * 发送 SSE 心跳包
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} mode - 心跳模式 ('comment' | 'content')
 * @param {string} [modelName] - 模型名称（content 模式需要）
 */
export function sendHeartbeat(res, mode, modelName) {
    if (res.writableEnded) return;

    if (mode === 'comment') {
        res.write(`:keepalive\n\n`);
    } else {
        // content 模式：发送空 delta
        const chunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'default-model',
            choices: [{
                index: 0,
                delta: { content: '' },
                finish_reason: null
            }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
}

/**
 * 发送统一 API 错误响应 (OpenAI 标准格式)
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} options - 错误选项
 * @param {string} [options.code] - 错误码（使用 ERROR_CODES 枚举）
 * @param {string} [options.message] - 自定义错误消息（如提供则覆盖 code 对应的消息）
 * @param {number} [options.status] - 自定义 HTTP 状态码
 * @param {boolean} [options.isStreaming=false] - 是否为流式响应
 */
export function sendApiError(res, options) {
    const { code, message, status, isStreaming = false } = options;

    // 获取错误详情
    const details = code ? getErrorDetails(code) : null;
    const errorMessage = message || (details ? details.message : '未知错误');
    const errorType = details?.type || 'server_error';
    const httpStatus = status || (details ? details.status : 500);

    // 构造 OpenAI 标准错误响应体
    const payload = {
        error: {
            message: errorMessage,
            type: errorType,
            code: code || 'INTERNAL_ERROR'
        }
    };

    if (isStreaming) {
        // 流式响应：发送错误事件然后结束
        sendSse(res, payload);
        sendSseDone(res);
    } else {
        // 非流式响应
        sendJson(res, httpStatus, payload);
    }
}

/**
 * 构造 OpenAI 格式的聊天完成响应（非流式）
 * @param {string} content - 响应内容
 * @param {string} [modelName] - 模型名称
 * @param {string} [reasoningContent] - 思考/推理过程内容 (OpenAI o1 格式)
 * @returns {object} OpenAI 格式的响应对象
 */
export function buildChatCompletion(content, modelName, reasoningContent) {
    const message = {
        role: 'assistant',
        content: content
    };
    if (reasoningContent) {
        message.reasoning_content = reasoningContent;
    }

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            message,
            finish_reason: 'stop'
        }]
    };
}

/**
 * 构造 OpenAI 格式的流式聊天完成响应块
 * @param {string} content - 响应内容
 * @param {string} [modelName] - 模型名称
 * @param {string|null} [finishReason='stop'] - 完成原因
 * @param {string} [reasoningContent] - 思考/推理过程内容 (OpenAI o1 格式)
 * @returns {object} OpenAI 格式的流式响应块
 */
export function buildChatCompletionChunk(content, modelName, finishReason = 'stop', reasoningContent) {
    const delta = { content };
    if (reasoningContent) {
        delta.reasoning_content = reasoningContent;
    }

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };
}

// ==========================================
// Image Generation API (OpenAI /v1/images/generations compatible)
// ==========================================

/**
 * 从 data URI 中提取纯 base64 部分
 * @param {string} dataUri - data:image/xxx;base64,... 或纯 base64
 * @returns {string} 纯 base64 字符串
 */
export function extractPureBase64(dataUri) {
    if (!dataUri) return '';
    if (dataUri.startsWith('data:')) {
        const commaIdx = dataUri.indexOf(',');
        if (commaIdx >= 0 && commaIdx + 1 < dataUri.length) {
            return dataUri.substring(commaIdx + 1);
        }
    }
    return dataUri;
}

/**
 * 从 data URI 中提取 MIME 类型（如 "png", "jpeg"）
 * @param {string} dataUri - data URI 字符串
 * @returns {string} MIME 子类型
 */
export function extractMimeSubtype(dataUri) {
    if (!dataUri) return 'png';
    if (dataUri.startsWith('data:')) {
        const match = dataUri.match(/^data:image\/([^;]+);/);
        if (match) {
            const subtype = match[1].split('/')[0];
            return subtype || 'png';
        }
    }
    return 'png';
}

/**
 * 构造 OpenAI 标准格式的图片生成响应（非流式）
 * @param {string} b64Json - 纯 base64 图片数据
 * @param {string} [revisedPrompt] - 修正后的提示词
 * @param {string} [modelName] - 模型名称
 * @param {string} [outputFormat] - 输出格式 (png/jpeg/webp)
 * @param {string} [size] - 图片尺寸
 * @param {string} [quality] - 质量
 * @param {string} [background] - 背景模式
 * @returns {object} OpenAI Images API 标准响应
 */
export function buildImagesResponse(b64Json, { revisedPrompt, modelName, outputFormat, size, quality, background } = {}) {
    const response = {
        created: Math.floor(Date.now() / 1000),
        data: [{
            b64_json: b64Json
        }]
    };

    if (revisedPrompt) {
        response.data[0].revised_prompt = revisedPrompt;
    }
    if (outputFormat) {
        response.output_format = outputFormat;
    } else if (b64Json) {
        response.output_format = extractMimeSubtype(b64Json);
    }
    if (size) {
        response.size = size;
    }
    if (quality) {
        response.quality = quality;
    }
    if (background) {
        response.background = background;
    }
    if (modelName) {
        response.model = modelName;
    }

    return response;
}

/**
 * 构造图片生成流式 SSE 事件（局部图片）
 * @param {string} b64Partial - 部分 base64 数据
 * @param {number} [index=0] - 图片索引
 * @param {string} [outputFormat='png'] - 输出格式
 * @returns {object} SSE 事件数据
 */
export function buildImagePartialEvent(b64Partial, index = 0, outputFormat = 'png') {
    return {
        type: 'image_generation.partial_image',
        b64_json: b64Partial,
        partial_image_index: index,
        output_format: outputFormat
    };
}

/**
 * 构造图片生成流式 SSE 事件（完成）
 * @param {string} b64Json - 完整 base64 数据
 * @param {string} [outputFormat='png'] - 输出格式
 * @param {string} [revisedPrompt] - 修正后的提示词
 * @param {object} [usage] - Token 使用情况
 * @returns {object} SSE 事件数据
 */
export function buildImageCompletedEvent(b64Json, { outputFormat = 'png', revisedPrompt, usage } = {}) {
    const event = {
        type: 'image_generation.completed',
        b64_json: b64Json,
        output_format: outputFormat
    };

    if (revisedPrompt) {
        event.revised_prompt = revisedPrompt;
    }
    if (usage) {
        event.usage = usage;
    } else {
        event.usage = {
            input_tokens: 0,
            output_tokens: 1,
            output_tokens_details: {
                image_tokens: 1
            }
        };
    }

    return event;
}
