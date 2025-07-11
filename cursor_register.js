// ==UserScript==
// @name         Cursor Auto Registration Assistant (Modern)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Modern Cursor auto-registration assistant with streamlined UI and enhanced functionality. Automatically handles the complete registration workflow: generates random emails using your domain, retrieves verification codes from temporary mailbox via tempmail.plus API, supports spaced verification codes, and includes smart retry mechanisms. Perfect for Cloudflare email forwarding setups.
// @author       AI Assistant
// @match        https://authenticator.cursor.sh/*
// @match        https://www.cursor.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @connect      tempmail.plus
// @connect      *.cursor.sh
// @connect      *.cursor.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 配置管理
    const CONFIG = {
        tempMailAddress: GM_getValue('tempMailAddress', ''),
        epin: GM_getValue('epin', ''),
        registerDomain: GM_getValue('registerDomain', ''),
        maxRetries: 10,
        retryInterval: 3000
    };

    // 名字库
    const NAMES = {
        first: ['alex', 'emily', 'jason', 'olivia', 'ryan', 'sophia', 'thomas', 'isabella', 'william', 'mia'],
        last: ['taylor', 'anderson', 'thompson', 'jackson', 'white', 'harris', 'martin', 'thomas', 'lewis', 'clark']
    };

    // 全局变量
    let logger = null;
    let currentEmail = '';

    // 保存配置
    function saveConfig(newConfig) {
        Object.keys(newConfig).forEach(key => {
            if (key !== 'maxRetries' && key !== 'retryInterval') {
                GM_setValue(key, newConfig[key]);
                CONFIG[key] = newConfig[key];
            }
        });
    }

    // 生成随机邮箱
    function generateEmail() {
        const firstName = NAMES.first[Math.floor(Math.random() * NAMES.first.length)];
        const lastName = NAMES.last[Math.floor(Math.random() * NAMES.last.length)];
        const timestamp = Date.now().toString(36);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const username = `${firstName}${lastName}${timestamp}${random}`;

        if (!CONFIG.registerDomain) {
            throw new Error('请先配置注册邮箱域名');
        }

        return `${username}@${CONFIG.registerDomain}`;
    }

    // 等待元素出现
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const check = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime < timeout) {
                    setTimeout(check, 100);
                } else {
                    resolve(null);
                }
            };
            check();
        });
    }

    // 获取邮件列表
    function fetchMailList(email) {
        return new Promise((resolve, reject) => {
            const url = `https://tempmail.plus/api/mails?email=${email}&limit=20&epin=${CONFIG.epin}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        logger.log(`邮件列表响应: ${JSON.stringify(data)}`);
                        resolve(data);
                    } catch (error) {
                        reject(new Error('解析邮件列表失败'));
                    }
                },
                onerror: () => reject(new Error('获取邮件列表失败'))
            });
        });
    }

    // 获取邮件详情
    function fetchMailDetail(email, mailId) {
        return new Promise((resolve, reject) => {
            const url = `https://tempmail.plus/api/mails/${mailId}?email=${email}&epin=${CONFIG.epin}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        logger.log(`邮件详情响应: ${JSON.stringify(data)}`);
                        resolve(data);
                    } catch (error) {
                        reject(new Error('解析邮件详情失败'));
                    }
                },
                onerror: () => reject(new Error('获取邮件详情失败'))
            });
        });
    }

    // 提取验证码 - 改进版，支持带空格的验证码
    function extractCode(text) {
        logger.log(`尝试从邮件内容中提取验证码: ${text.substring(0, 200)}...`);

        // 首先尝试匹配连续的6位数字
        const directMatch = text.match(/(?<![a-zA-Z@.])\b\d{6}\b/);
        if (directMatch) {
            logger.log(`找到连续6位验证码: ${directMatch[0]}`);
            return directMatch[0];
        }

        // 如果没有找到连续6位数字，尝试匹配带空格的6位数字
        const spaceMatch = text.match(/(\d\s){5}\d/);
        if (spaceMatch) {
            const code = spaceMatch[0].replace(/\s/g, '');
            logger.log(`找到带空格的验证码: ${spaceMatch[0]} -> ${code}`);
            return code;
        }

        // 其他常见格式
        const patterns = [
            /code is:?\s*(\d{6})/i,
            /verification code[^\d]*(\d{6})/i,
            /your code[^\d]*(\d{6})/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                logger.log(`通过模式匹配找到验证码: ${match[1]}`);
                return match[1];
            }
        }

        logger.log('未能提取到验证码', 'warning');
        return null;
    }

    // 删除邮件
    function deleteEmail(email, firstId) {
        return new Promise((resolve) => {
            const deleteUrl = 'https://tempmail.plus/api/mails/';
            const payload = `email=${email}&first_id=${firstId}&epin=${CONFIG.epin}`;

            let retryCount = 0;
            const maxRetries = 5;

            function tryDelete() {
                GM_xmlhttpRequest({
                    method: 'DELETE',
                    url: deleteUrl,
                    data: payload,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    onload: (response) => {
                        try {
                            const result = JSON.parse(response.responseText);
                            if (result.result === true) {
                                logger.log('邮件删除成功', 'success');
                                resolve(true);
                                return;
                            }
                        } catch (error) {
                            logger.log(`解析删除响应失败: ${error}`, 'warning');
                        }

                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            logger.log(`删除邮件失败，正在重试 (${retryCount}/${maxRetries})...`, 'warning');
                            setTimeout(tryDelete, 500);
                        } else {
                            logger.log('删除邮件失败，已达到最大重试次数', 'error');
                            resolve(false);
                        }
                    },
                    onerror: (error) => {
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            logger.log(`删除邮件出错，正在重试 (${retryCount}/${maxRetries})...`, 'warning');
                            setTimeout(tryDelete, 500);
                        } else {
                            logger.log(`删除邮件失败: ${error}`, 'error');
                            resolve(false);
                        }
                    }
                });
            }

            tryDelete();
        });
    }

    // 获取验证码
    async function getVerificationCode() {
        if (!CONFIG.tempMailAddress) {
            throw new Error('请先配置临时邮箱');
        }

        const email = CONFIG.tempMailAddress;
        logger.log(`正在获取验证码，临时邮箱: ${email}`);

        for (let i = 0; i < CONFIG.maxRetries; i++) {
            try {
                logger.log(`第 ${i + 1}/${CONFIG.maxRetries} 次尝试获取验证码`);

                const mailList = await fetchMailList(email);
                if (!mailList || !mailList.result || !mailList.first_id) {
                    logger.log('暂无新邮件，等待中...', 'warning');
                    await new Promise(resolve => setTimeout(resolve, CONFIG.retryInterval));
                    continue;
                }

                const mailDetail = await fetchMailDetail(email, mailList.first_id);
                if (!mailDetail || !mailDetail.result || !mailDetail.text) {
                    logger.log('邮件内容为空', 'warning');
                    await new Promise(resolve => setTimeout(resolve, CONFIG.retryInterval));
                    continue;
                }

                // 记录邮件主题和内容
                const mailSubject = mailDetail.subject || '';
                logger.log(`找到邮件主题: ${mailSubject}`);

                const code = extractCode(mailDetail.text);
                if (code) {
                    logger.log(`成功获取验证码: ${code}`, 'success');
                    // 删除已读邮件
                    await deleteEmail(email, mailList.first_id);
                    return code;
                }

                logger.log('未找到验证码，继续尝试...', 'warning');
                await new Promise(resolve => setTimeout(resolve, CONFIG.retryInterval));
            } catch (error) {
                logger.log(`获取验证码出错: ${error.message}`, 'error');
                await new Promise(resolve => setTimeout(resolve, CONFIG.retryInterval));
            }
        }

        throw new Error('获取验证码失败，请检查配置或手动操作');
    }

    // 填写邮箱
    async function fillEmail() {
        const emailInput = await waitForElement('input[name="email"]');
        if (!emailInput) {
            throw new Error('未找到邮箱输入框');
        }

        currentEmail = generateEmail();
        emailInput.value = currentEmail;
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        logger.log(`已填写邮箱: ${currentEmail}`, 'success');

        const submitBtn = await waitForElement('button[type="submit"]');
        if (submitBtn) {
            submitBtn.click();
            logger.log('已点击提交按钮', 'success');
        }
    }

    // 填写验证码
    async function fillVerificationCode() {
        const code = await getVerificationCode();
        if (!code) {
            throw new Error('未能获取验证码');
        }

        // 查找验证码输入框
        const codeInputs = document.querySelectorAll('input[maxlength="1"][inputmode="numeric"]');
        if (codeInputs.length === 6) {
            // 分离式输入框
            for (let i = 0; i < 6; i++) {
                codeInputs[i].value = code[i];
                codeInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            }
            logger.log('已填写验证码', 'success');
        } else {
            // 单个输入框
            const codeInput = await waitForElement('input[name="code"]');
            if (codeInput) {
                codeInput.value = code;
                codeInput.dispatchEvent(new Event('input', { bubbles: true }));
                logger.log('已填写验证码', 'success');
            }
        }

        // 自动提交
        await new Promise(resolve => setTimeout(resolve, 1000));
        const submitBtn = await waitForElement('button[type="submit"]');
        if (submitBtn && !submitBtn.disabled) {
            submitBtn.click();
            logger.log('已提交验证码', 'success');
        }
    }

    // 日志系统
    class Logger {
        constructor() {
            this.container = null;
            this.content = null;
            this.init();
        }

        init() {
            this.createUI();
            this.addStyles();
            this.bindEvents();
        }

        createUI() {
            this.container = document.createElement('div');
            this.container.id = 'cursor-logger';
            this.container.innerHTML = `
                <div class="logger-header">
                    <span>🚀 Cursor注册助手 v3.0</span>
                    <div class="logger-controls">
                        <button id="config-btn" title="配置">⚙️</button>
                        <button id="start-btn" title="开始注册">▶️</button>
                        <button id="clear-btn" title="清除日志">🗑️</button>
                        <button id="minimize-btn" title="最小化">➖</button>
                    </div>
                </div>
                <div id="log-content" class="logger-content"></div>
            `;
            document.body.appendChild(this.container);
            this.content = document.getElementById('log-content');
        }

        addStyles() {
            GM_addStyle(`
                #cursor-logger {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 350px;
                    max-height: 400px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    z-index: 999999;
                    font-family: 'Segoe UI', Arial, sans-serif;
                    overflow: hidden;
                }
                .logger-header {
                    padding: 12px 16px;
                    background: rgba(255,255,255,0.1);
                    color: white;
                    font-weight: bold;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    backdrop-filter: blur(10px);
                }
                .logger-controls {
                    display: flex;
                    gap: 8px;
                }
                .logger-controls button {
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: white;
                    padding: 6px 10px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s;
                }
                .logger-controls button:hover {
                    background: rgba(255,255,255,0.3);
                    transform: scale(1.05);
                }
                .logger-content {
                    padding: 16px;
                    max-height: 300px;
                    overflow-y: auto;
                    background: rgba(255,255,255,0.95);
                    color: #333;
                    font-size: 13px;
                    line-height: 1.4;
                }
                .log-entry {
                    margin-bottom: 8px;
                    padding: 8px 12px;
                    border-radius: 6px;
                    border-left: 4px solid #667eea;
                }
                .log-entry.success { border-left-color: #4CAF50; background: #e8f5e9; }
                .log-entry.error { border-left-color: #f44336; background: #ffebee; }
                .log-entry.warning { border-left-color: #ff9800; background: #fff3e0; }
                .log-entry.info { border-left-color: #2196F3; background: #e3f2fd; }
            `);
        }

        bindEvents() {
            document.getElementById('config-btn').addEventListener('click', () => this.showConfig());
            document.getElementById('start-btn').addEventListener('click', () => this.startRegistration());
            document.getElementById('clear-btn').addEventListener('click', () => this.clear());
            document.getElementById('minimize-btn').addEventListener('click', () => this.toggle());
        }

        log(message, type = 'info') {
            const entry = document.createElement('div');
            entry.className = `log-entry ${type}`;
            const time = new Date().toLocaleTimeString();
            entry.textContent = `[${time}] ${message}`;
            this.content.appendChild(entry);
            this.content.scrollTop = this.content.scrollHeight;
        }

        clear() {
            this.content.innerHTML = '';
            this.log('日志已清除');
        }

        toggle() {
            const content = this.content;
            const btn = document.getElementById('minimize-btn');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                btn.textContent = '➖';
            } else {
                content.style.display = 'none';
                btn.textContent = '➕';
            }
        }

        showConfig() {
            this.createConfigModal();
        }

        createConfigModal() {
            const modal = document.createElement('div');
            modal.id = 'config-modal';
            modal.innerHTML = `
                <div class="modal-overlay"></div>
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>📧 邮箱配置</h3>
                        <button id="close-modal">✕</button>
                    </div>
                    <div class="modal-body">
                        <div class="form-group">
                            <label>临时邮箱地址:</label>
                            <input type="text" id="temp-mail" value="${CONFIG.tempMailAddress}" placeholder="完整的临时邮箱地址，如: abc123@mailto.plus">
                            <small style="color: #666; font-size: 12px;">用于接收验证码的临时邮箱</small>
                        </div>
                        <div class="form-group">
                            <label>邮箱PIN码:</label>
                            <input type="text" id="epin" value="${CONFIG.epin}" placeholder="临时邮箱的PIN码（如果有的话）">
                            <small style="color: #666; font-size: 12px;">某些临时邮箱需要PIN码才能访问</small>
                        </div>
                        <div class="form-group">
                            <label>注册邮箱域名:</label>
                            <input type="text" id="register-domain" value="${CONFIG.registerDomain}" placeholder="example.com">
                            <small style="color: #666; font-size: 12px;">用于生成注册邮箱的域名，不要包含@符号</small>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button id="save-config">保存配置</button>
                        <button id="cancel-config">取消</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);
            this.addModalStyles();
            this.bindModalEvents(modal);
        }

        addModalStyles() {
            GM_addStyle(`
                #config-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 1000000;
                }
                .modal-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0,0,0,0.5);
                    backdrop-filter: blur(5px);
                }
                .modal-content {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 12px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    width: 400px;
                    max-width: 90vw;
                }
                .modal-header {
                    padding: 20px;
                    border-bottom: 1px solid #eee;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .modal-header h3 {
                    margin: 0;
                    color: #333;
                }
                .modal-header button {
                    background: none;
                    border: none;
                    font-size: 18px;
                    cursor: pointer;
                    color: #999;
                }
                .modal-body {
                    padding: 20px;
                }
                .form-group {
                    margin-bottom: 16px;
                }
                .form-group label {
                    display: block;
                    margin-bottom: 6px;
                    font-weight: 500;
                    color: #555;
                }
                .form-group input {
                    width: 100%;
                    padding: 10px 12px;
                    border: 2px solid #e1e5e9;
                    border-radius: 6px;
                    font-size: 14px;
                    transition: border-color 0.2s;
                    box-sizing: border-box;
                }
                .form-group input:focus {
                    outline: none;
                    border-color: #667eea;
                }
                .modal-footer {
                    padding: 20px;
                    border-top: 1px solid #eee;
                    display: flex;
                    gap: 12px;
                    justify-content: flex-end;
                }
                .modal-footer button {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                #save-config {
                    background: #667eea;
                    color: white;
                }
                #save-config:hover {
                    background: #5a6fd8;
                }
                #cancel-config {
                    background: #f5f5f5;
                    color: #666;
                }
                #cancel-config:hover {
                    background: #e9e9e9;
                }
            `);
        }

        bindModalEvents(modal) {
            const closeModal = () => modal.remove();

            document.getElementById('close-modal').addEventListener('click', closeModal);
            document.getElementById('cancel-config').addEventListener('click', closeModal);
            document.querySelector('.modal-overlay').addEventListener('click', closeModal);

            document.getElementById('save-config').addEventListener('click', () => {
                const newConfig = {
                    tempMailAddress: document.getElementById('temp-mail').value.trim(),
                    epin: document.getElementById('epin').value.trim(),
                    registerDomain: document.getElementById('register-domain').value.trim()
                };

                // 验证临时邮箱格式
                if (newConfig.tempMailAddress && !/^.+@.+\..+$/.test(newConfig.tempMailAddress)) {
                    alert('请输入完整的临时邮箱地址，格式如: abc123@mailto.plus');
                    return;
                }

                saveConfig(newConfig);
                this.log('配置已保存', 'success');
                closeModal();
            });
        }

        async startRegistration() {
            const btn = document.getElementById('start-btn');
            btn.textContent = '⏳';
            btn.disabled = true;

            try {
                this.log('开始自动注册流程...', 'info');

                // 检查当前页面
                const currentUrl = window.location.href;

                if (currentUrl.includes('/magic-code')) {
                    // 验证码页面
                    this.log('检测到验证码页面，开始填写验证码', 'info');
                    await fillVerificationCode();
                } else if (document.querySelector('input[name="email"]')) {
                    // 邮箱输入页面
                    this.log('检测到邮箱输入页面，开始填写邮箱', 'info');
                    await fillEmail();
                } else {
                    this.log('请手动导航到注册页面', 'warning');
                }

            } catch (error) {
                this.log(`注册流程失败: ${error.message}`, 'error');
            } finally {
                btn.textContent = '▶️';
                btn.disabled = false;
            }
        }
    }

    // 自动处理页面跳转
    function handlePageChange() {
        const currentUrl = window.location.href;

        // 自动点击首页登录按钮
        if (currentUrl.includes('cursor.com') && !currentUrl.includes('authenticator')) {
            setTimeout(() => {
                const loginBtn = document.querySelector('a[href*="/api/auth/login"]');
                if (loginBtn) {
                    logger.log('自动点击登录按钮');
                    loginBtn.click();
                }
            }, 1000);
        }

        // 自动点击使用验证码登录
        if (currentUrl.includes('/password')) {
            setTimeout(() => {
                const magicBtn = document.querySelector('button[name="intent"][value="magic-code"]');
                if (magicBtn) {
                    logger.log('自动点击"使用验证码登录"按钮');
                    magicBtn.click();
                }
            }, 1000);
        }
    }

    // 初始化
    function init() {
        // 等待页面加载
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                logger = new Logger();
                logger.log('Cursor注册助手已启动', 'success');
                handlePageChange();
            });
        } else {
            logger = new Logger();
            logger.log('Cursor注册助手已启动', 'success');
            handlePageChange();
        }

        // 监听URL变化
        let lastUrl = location.href;
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                if (logger) {
                    logger.log(`页面跳转: ${url}`);
                    handlePageChange();
                }
            }
        }).observe(document, { subtree: true, childList: true });
    }

    // 启动脚本
    init();

})();
