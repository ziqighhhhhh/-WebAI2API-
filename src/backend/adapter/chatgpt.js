/**
 * @fileoverview ChatGPT 图片生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck,
    waitApiResponse,
    useContextDownload
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://chatgpt.com/images/';
const INPUT_SELECTOR = '.ProseMirror';

/**
 * 执行生图任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID (此适配器未使用)
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{image?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
    const sendBtnLocator = page.getByRole('button', { name: 'Send prompt' });

    try {
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 等待输入框加载
        await waitForInput(page, INPUT_SELECTOR, { click: false });

        // 2. 上传图片
        if (imgPaths && imgPaths.length > 0) {

            const expectedUploads = imgPaths.length;
            let uploadedCount = 0;
            let processedCount = 0;
            logger.info('适配器', `开始上传 ${expectedUploads} 张图片...`, meta);
            logger.debug('适配器', '点击添加文件按钮...', meta);
            const addFilesBtn = page.getByRole('button', { name: 'Add files and more' });

            await uploadFilesViaChooser(page, addFilesBtn, imgPaths, {
                uploadValidator: (response) => {
                    const url = response.url();
                    if (response.status() === 200) {
                        // 上传请求
                        if (url.includes('backend-api/files') && !url.includes('process_upload_stream')) {
                            uploadedCount++;
                            logger.debug('适配器', `图片上传进度: ${uploadedCount}/${expectedUploads}`, meta);
                            return false;
                        }
                        // 处理完成请求
                        if (url.includes('backend-api/files/process_upload_stream')) {
                            processedCount++;
                            logger.info('适配器', `图片处理进度: ${processedCount}/${expectedUploads}`, meta);

                            if (processedCount >= expectedUploads) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }, meta);
            logger.info('适配器', '图片上传完成', meta);
        }

        // 3. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        await safeClick(page, INPUT_SELECTOR, { bias: 'input' });
        await humanType(page, INPUT_SELECTOR, prompt);

        // 4. 发送提示词
        logger.debug('适配器', '发送提示词...', meta);
        await page.keyboard.press('Enter');

        logger.info('适配器', '等待生成结果...', meta);

        // 5. 等待 conversation API 返回
        let conversationResponse;
        try {
            conversationResponse = await waitApiResponse(page, {
                urlMatch: 'backend-api/f/conversation',
                method: 'POST',
                timeout: waitTimeout,  // 图片生成可能较慢
                meta
            });
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        // 检查响应状态
        if (conversationResponse.status() !== 200) {
            logger.error('适配器', `API 返回错误: HTTP ${conversationResponse.status()}`, meta);
            return { error: `API 返回错误: HTTP ${conversationResponse.status()}` };
        }

        // 5.5 解析 conversation 响应，检查是否是纯文本回复（拒绝/限流场景）
        let conversationText = '';
        let isImageGenerationStarted = false;
        let conversationBody = '';
        try {
            conversationBody = await conversationResponse.text();

            // 检查是否有图片生成相关的内容 (dalle 工具调用或 file_ 文件引用)
            // 注意：不使用 'image' 关键词，因为拒绝消息也会包含这个词
            isImageGenerationStarted = conversationBody.includes('dalle') || conversationBody.includes('file_');
            logger.debug('适配器', `isImageGenerationStarted: ${isImageGenerationStarted}`, meta);

            // 提取文本内容
            const lines = conversationBody.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(dataStr);
                    // 提取初始文本 (channel=final 的 assistant 消息)
                    if (data.v?.message?.channel === 'final' &&
                        data.v?.message?.author?.role === 'assistant' &&
                        data.v?.message?.content?.parts?.length > 0) {
                        const part = data.v.message.content.parts[0];
                        if (typeof part === 'string') {
                            conversationText = part;
                        }
                    }
                    // patch 格式累加 (data.v 是 patch 操作数组)
                    if (Array.isArray(data.v)) {
                        for (const patch of data.v) {
                            if (patch.o === 'append' && patch.p === '/message/content/parts/0' && patch.v) {
                                conversationText += patch.v;
                            }
                        }
                    }
                } catch { }
            }
            logger.debug('适配器', `提取到文本 (${conversationText.length} 字符): ${conversationText.substring(0, 200)}...`, meta);
        } catch (e) {
            logger.warn('适配器', `解析 conversation 响应失败: ${e.message}`, meta);
        }

        // 早期检测：如果文本表明是拒绝/限流，立即返回，不等待图片超时
        if (conversationText) {
            // 检查是否是速率限制错误 (不重试，同账号重试也没用)
            const isRateLimit = conversationBody.includes('RateLimitException') ||
                conversationBody.includes('rate limit') ||
                /limit.*reset/i.test(conversationText);

            if (isRateLimit) {
                logger.warn('适配器', `早期检测到速率限制: ${conversationText.substring(0, 200)}...`, meta);
                return { error: `触发速率限制: ${conversationText.substring(0, 200)}`, retryable: false };
            }

            // 如果没有图片生成迹象，检查是否是内容被拒绝
            if (!isImageGenerationStarted) {
                const isContentRejection = /cannot|can't|unable|sorry|policy|violat/i.test(conversationText);
                if (isContentRejection) {
                    logger.warn('适配器', `早期检测到内容拒绝: ${conversationText.substring(0, 200)}...`, meta);
                    return { error: `内容被拒绝: ${conversationText.substring(0, 200)}`, retryable: false };
                }
            }
        }

        logger.info('适配器', '生成中，等待图片就绪...', meta);

        // 6. 监听文件状态接口，等待图片生成完成
        // 如果 conversation 响应中没有图片生成迹象，使用较短超时
        let downloadUrl = null;
        let fileName = null;
        const imageTimeout = isImageGenerationStarted ? 120000 : 30000;

        try {
            await page.waitForResponse(async (response) => {
                const url = response.url();
                if (!url.includes('backend-api/files/download/file_')) return false;
                if (response.status() !== 200) return false;

                try {
                    const json = await response.json();
                    const fn = json.file_name;
                    const dl = json.download_url;

                    if (fn && fn.startsWith('user-') && !fn.includes('.part') && dl) {
                        fileName = fn;
                        downloadUrl = dl;
                        logger.info('适配器', `图片生成完成: ${fn}`, meta);
                        return true;
                    } else {
                        logger.debug('适配器', `图片生成中或非生成图片: ${fn || '无文件名'}`, meta);
                        return false;
                    }
                } catch {
                    return false;
                }
            }, { timeout: imageTimeout });
        } catch (e) {
            logger.debug('适配器', `等待图片超时, conversationText长度: ${conversationText.length}, downloadUrl: ${downloadUrl}`, meta);

            // 超时时检查是否有 conversation 中的文本内容
            if (conversationText && !downloadUrl) {
                const isRateLimit = conversationBody.includes('RateLimitException') ||
                    conversationBody.includes('rate limit') ||
                    /limit.*reset/i.test(conversationText);

                if (isRateLimit) {
                    logger.warn('适配器', `触发速率限制: ${conversationText.substring(0, 200)}...`, meta);
                    return { error: `触发速率限制: ${conversationText.substring(0, 200)}`, retryable: false };
                }

                logger.warn('适配器', `模型返回文本而非图片: ${conversationText.substring(0, 200)}...`, meta);
                return { error: `模型返回文本而非图片: ${conversationText.substring(0, 200)}`, retryable: false };
            }

            // 如果没有提取到文本，但有原始响应体，尝试用简单方式提取
            if (!conversationText && conversationBody) {
                const partsMatch = conversationBody.match(/"parts":\s*\["([^"]+)"\]/);
                if (partsMatch && partsMatch[1]) {
                    logger.warn('适配器', `通过正则提取到文本: ${partsMatch[1].substring(0, 200)}...`, meta);
                    return { error: `模型返回文本而非图片: ${partsMatch[1].substring(0, 200)}`, retryable: false };
                }
            }

            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        if (!downloadUrl) {
            logger.error('适配器', '未获取到图片下载链接', meta);
            return { error: '未获取到图片下载链接' };
        }

        logger.info('适配器', '正在下载图片...', meta);

        // 7. 使用 useContextDownload 下载图片
        const imgDlCfg = config?.backend?.pool?.failover || {};
        const result = await useContextDownload(downloadUrl, page, {
            retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 2) : 0
        });
        if (result.error) {
            logger.error('适配器', result.error, meta);
            return result;
        }

        logger.info('适配器', '已获取图片，任务完成', meta);
        return result;

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
    id: 'chatgpt',
    displayName: 'ChatGPT (图片生成)',
    description: '使用 ChatGPT 官网生成图片，支持参考图片上传。需要已登录的 ChatGPT 账户，请使用会员账号 (包含 K12 教师认证)，非会员账号会有速率限制。',

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    // 模型列表
    models: [
        { id: 'gpt-image-2', codeName: 'gpt-image-1.5', imagePolicy: 'optional' },
        { id: 'gpt-image-1.5', imagePolicy: 'optional' }
    ],

    // 无需导航处理器
    navigationHandlers: [],

    // 核心生图方法
    generate
};
