/**
 * @fileoverview LMArena 图片生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    pasteImages
} from '../engine/utils.js';
import {
    waitApiResponse,
    normalizePageError,
    normalizeHttpError,
    waitForInput,
    gotoWithCheck,
    useContextDownload
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://arena.ai/image/direct';

/**
 * 从响应文本中提取图片 URL
 * @param {string} text - 响应文本内容
 * @returns {string|null} 提取到的图片 URL，如果未找到则返回 null
 */
function extractImage(text) {
    if (!text) return null;
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.startsWith('a2:')) {
            try {
                const data = JSON.parse(line.substring(3));
                if (data?.[0]?.image) return data[0].image;
            } catch (e) { }
        }
    }
    return null;
}

/**
 * 从响应文本中提取错误信息
 * SSE 错误格式:
 * - a3: 模型提供方错误 (如 OpenAI moderation_blocked)
 * - ae: Arena 平台错误 (如内容审核拦截)
 * @param {string} text - 响应文本内容
 * @returns {string|null} 提取到的错误信息，如果未找到则返回 null
 */
function extractError(text) {
    if (!text) return null;
    const lines = text.split('\n');
    for (const line of lines) {
        // a3: 模型提供方错误
        if (line.startsWith('a3:')) {
            try {
                const errorMsg = JSON.parse(line.substring(3));
                if (typeof errorMsg === 'string') {
                    // 尝试提取嵌套的 JSON 错误
                    const jsonMatch = errorMsg.match(/\{[\s\S]*"error"[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            const nested = JSON.parse(jsonMatch[0]);
                            if (nested.error?.message) {
                                return `[模型错误] ${nested.error.message} (code: ${nested.error.code || 'unknown'})`;
                            }
                        } catch { }
                    }
                    return `[模型错误] ${errorMsg}`;
                }
            } catch (e) { }
        }
        // ae: Arena 平台错误
        if (line.startsWith('ae:')) {
            try {
                const errorData = JSON.parse(line.substring(3));
                if (errorData?.message) {
                    return `[平台错误] ${errorData.message}`;
                }
                if (typeof errorData === 'string') {
                    return `[平台错误] ${errorData}`;
                }
            } catch (e) { }
        }
    }
    return null;
}


/**
 * 执行生图任务
 * @param {object} context - 浏览器上下文 { page, client }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 指定的模型 ID (可选)
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{image?: string, text?: string, error?: string}>} 生成结果
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
    const textareaSelector = 'textarea';

    try {
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 等待输入框加载
        await waitForInput(page, textareaSelector, { click: true });

        // 2. 选择模型
        if (modelId) {
            logger.debug('适配器', `选择模型: ${modelId}`, meta);
            // 使用键盘导航展开模型选择框：按两次 Shift+Tab 然后 Enter
            await page.keyboard.down('Shift');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.up('Shift');
            await sleep(100, 200);
            await page.keyboard.press('Enter');

            // 获取模型配置，优先使用 codeName，否则使用 id
            const modelConfig = manifest.models.find(m => m.id === modelId);
            const searchText = modelConfig?.codeName || modelId;

            // 模拟粘贴输入模型名称
            await page.evaluate((text) => {
                document.execCommand('insertText', false, text);
            }, searchText);

            // 等待过滤完成：第一个选项包含目标模型的主 ID
            // searchText 可能是 codeName（含括号说明），但过滤后的选项应该包含 modelId
            try {
                await page.waitForFunction(
                    (targetId) => {
                        const firstOption = document.querySelector('[role="option"]');
                        return firstOption && firstOption.textContent?.includes(targetId);
                    },
                    modelId,
                    { timeout: 5000 }
                );
            } catch {
                // 超时也继续，可能列表结构不同
                logger.debug('适配器', `等待模型选项过滤超时，继续执行`, meta);
            }
            await sleep(300, 500);
            await page.keyboard.press('Enter');
        }

        // 3. 上传图片
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片`, meta);
            await pasteImages(page, textareaSelector, imgPaths, {}, meta);
            logger.info('适配器', '图片上传完成', meta);
        }

        // 4. 输入提示词
        await safeClick(page, textareaSelector, { bias: 'input' });
        logger.info('适配器', '输入提示词...', meta);
        await humanType(page, textareaSelector, prompt);

        // 5. 先启动 API 监听
        logger.debug('适配器', '启动 API 监听...', meta);
        const responsePromise = waitApiResponse(page, {
            urlMatch: '/nextjs-api/stream',
            method: 'POST',
            timeout: waitTimeout,
            meta
        });

        // 6. 发送提示词
        logger.info('适配器', '发送提示词...', meta);
        await safeClick(page, 'button[type="submit"]', { bias: 'button' });

        logger.info('适配器', '等待生成结果...', meta);

        // 7. 等待 API 响应
        let response;
        try {
            response = await responsePromise;
        } catch (e) {
            // 使用公共错误处理
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        // 7. 解析响应结果
        const content = await response.text();

        // 8. 检查 HTTP 错误
        const httpError = normalizeHttpError(response, content);
        if (httpError) {
            logger.error('适配器', `请求生成时返回错误: ${httpError.error}`, meta);
            return { error: `请求生成时返回错误: ${httpError.error}`, retryable: httpError.retryable };
        }

        // 8.5 检查 SSE 错误 (a3/ae 行)
        const sseError = extractError(content);
        if (sseError) {
            logger.warn('适配器', `SSE 错误: ${sseError}`, meta);
            return { error: sseError, retryable: false };
        }

        // 9. 提取图片 URL
        const img = extractImage(content);
        if (img) {
            // 检查是否配置了返回 URL
            const returnUrl = config?.backend?.adapter?.lmarena?.returnUrl || false;
            if (returnUrl) {
                logger.info('适配器', '已获取结果，返回 URL', meta);
                return { image: img };
            }

            logger.info('适配器', '已获取结果，正在下载图片...', meta);
            const imgDlCfg = config?.backend?.pool?.failover || {};
            const result = await useContextDownload(img, page, {
                retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 2) : 0
            });
            if (result.image) {
                logger.info('适配器', '已下载图片，任务完成', meta);
            }
            return result;
        } else {
            logger.warn('适配器', '未获得结果，响应中无图片数据', { ...meta, preview: content.substring(0, 150) });
            return { error: `未获得结果，响应中无图片数据: ${content.substring(0, 200)}` };
        }

    } catch (err) {
        // 顶层错误处理
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'lmarena',
    displayName: 'LMArena (图片生成)',
    description: '使用 LMArena 平台生成图片，支持多种图片生成模型。需要已登录的 LMArena 账户，若不登录会频繁弹出人机验证码且有速率限制。',

    // 配置项模式
    configSchema: [
        {
            key: 'returnUrl',
            label: '返回图片 URL',
            type: 'boolean',
            default: false,
            note: '开启后直接返回图片 URL (但其他不支持该选项的适配器仍然会返回 Base64)'
        }
    ],

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    // 模型列表
    models: [
        { id: 'gemini-3.1-flash-image-preview', codeName: 'gemini-3.1-flash-image-preview (nano-banana-2) [web-search]', imagePolicy: 'optional' },
        { id: 'gpt-image-2', codeName: 'gpt-image-1.5-high-fidelity', imagePolicy: 'optional' },
        { id: 'gpt-image-1.5-high-fidelity', imagePolicy: 'optional' },
        { id: 'gemini-3-pro-image-preview-2k', codeName: 'gemini-3-pro-image-preview-2k (nano-banana-pro)', imagePolicy: 'optional' },
        { id: 'mai-image-2', imagePolicy: 'forbidden' },
        { id: 'reve-v1.5', imagePolicy: 'required' },
        { id: 'flux-2-max', imagePolicy: 'optional' },
        { id: 'flux-2-flex', imagePolicy: 'optional' },
        { id: 'flux-2-pro', imagePolicy: 'optional' },
        { id: 'hunyuan-image-3.0', imagePolicy: 'forbidden' },
        { id: 'flux-2-dev', imagePolicy: 'optional' },
        { id: 'seedream-4.5', imagePolicy: 'optional' },
        { id: 'qwen-image-2512', imagePolicy: 'forbidden' },
        { id: 'imagen-4.0-generate-001', imagePolicy: 'forbidden' },
        { id: 'wan2.5-t2i-preview', imagePolicy: 'forbidden' },
        { id: 'gpt-image-1', imagePolicy: 'optional' },
        { id: 'seedream-5.0-lite', imagePolicy: 'optional' },
        { id: 'seedream-4-high-res-fal', imagePolicy: 'optional' },
        { id: 'gpt-image-1-mini', imagePolicy: 'optional' },
        { id: 'recraft-v4', imagePolicy: 'forbidden' },
        { id: 'seedream-3', imagePolicy: 'forbidden' },
        { id: 'flux-2-klein-9b', imagePolicy: 'optional' },
        { id: 'qwen-image-prompt-extend', imagePolicy: 'forbidden' },
        { id: 'flux-1-kontext-pro', imagePolicy: 'optional' },
        { id: 'imagen-3.0-generate-002', imagePolicy: 'forbidden' },
        { id: 'ideogram-v3-quality', imagePolicy: 'forbidden' },
        { id: 'photon', imagePolicy: 'forbidden' },
        { id: 'p-image', imagePolicy: 'forbidden' },
        { id: 'flux-2-klein-4b', imagePolicy: 'optional' },
        { id: 'recraft-v3', imagePolicy: 'forbidden' },
        { id: 'runway-gen4', imagePolicy: 'forbidden' },
        { id: 'lucid-origin', imagePolicy: 'forbidden' },
        { id: 'dall-e-3', imagePolicy: 'forbidden' },
        { id: 'flux-1-kontext-dev', imagePolicy: 'optional' },
        { id: 'imagen-4.0-ultra-generate-001', imagePolicy: 'forbidden' },
        { id: 'p-image-edit', imagePolicy: 'required' },
        { id: 'hunyuan-image-2.1', imagePolicy: 'forbidden' },
        { id: 'reve-v1.1', imagePolicy: 'required' },
        { id: 'vidu-q2-image', imagePolicy: 'optional' },
        { id: 'imagen-4.0-fast-generate-001', imagePolicy: 'forbidden' },
        { id: 'qwen-image-2.0', imagePolicy: 'forbidden' },
        { id: 'qwen-image-2.0-pro', imagePolicy: 'forbidden' },
        { id: 'reve-v1.1-fast', imagePolicy: 'required' },
        { id: 'kling-image-o1', imagePolicy: 'forbidden' },
        { id: 'chatgpt-image-latest-high-fidelity', codeName: 'chatgpt-image-latest-high-fidelity (20251216)', imagePolicy: 'required' },
        { id: 'hunyuan-image-3.0-instruct', imagePolicy: 'required' },
        { id: 'wan2.7-image', imagePolicy: 'required' },
        { id: 'grok-imagine-image-pro', imagePolicy: 'forbidden' },
        { id: 'grok-imagine-image', imagePolicy: 'forbidden' },
        { id: 'wan2.7-image-pro', imagePolicy: 'required' },
        { id: 'qwen-image-edit-2511', imagePolicy: 'required' },
        { id: 'gemini-2.5-flash-image-preview', codeName: 'gemini-2.5-flash-image-preview (nano-banana)', imagePolicy: 'optional' },
        { id: 'wan2.5-i2i-preview', imagePolicy: 'required' },
        { id: 'qwen-image-edit', imagePolicy: 'required' },
        { id: 'wan2.6-image', imagePolicy: 'required' },
        { id: 'seededit-3.0', imagePolicy: 'required' },
        { id: 'wan2.6-t2i', imagePolicy: 'forbidden' },
    ],

    // 无需导航处理器
    navigationHandlers: [],

    // 核心生图方法
    generate
};
