/**
 * 投标报价计算器 - 核心逻辑
 */
const BID_CALCULATOR_STORAGE_KEY = 'bid-calculator:v1';

function createDefaultConfig() {
    return {
        mode: 'single',        // 'single' 单低模式 | 'double' 双低模式
        maxPrice: null,        // 上限价（超出则废标）
        minPrice: null,        // 下限价（低于则废标）
        fullScore: 30,         // 价格分满分
        deductUp: 1.0,         // 上浮扣分系数（每高于基准价1%扣多少分）
        deductDown: 0.5,       // 下浮扣分系数（每低于基准价1%扣多少分，设为0表示低于不扣分）
        minScore: 0,           // 最低得分
        lowestWeight: 40,      // 双低模式下最低价权重(%)
    };
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function bidCalculator() {
    return {
        // 配置参数
        config: createDefaultConfig(),

        // 投标报价列表
        bids: [],

        // 新增报价表单
        newBid: {
            name: '',
            price: null
        },

        // 报价ID计数器
        bidIdCounter: 0,

        // ========== 方案对比功能 ==========

        // 方案列表
        scenarios: [],

        // 当前选中的方案ID（null 表示当前编辑中的未保存方案）
        currentScenarioId: null,

        // 方案名称输入
        newScenarioName: '',

        // 对比模式开关
        compareMode: false,

        // 用于对比的方案ID列表
        compareScenarioIds: [],

        // 方案ID计数器
        scenarioIdCounter: 0,

        // 最近一次保存或更新的方案ID
        lastSavedScenarioId: null,

        /**
         * Alpine 初始化：恢复上次保存的方案数据
         */
        init() {
            this.restoreState();
        },

        /**
         * 添加报价
         */
        addBid() {
            if (!this.newBid.name || !this.newBid.price || this.newBid.price <= 0) return;

            this.bids.push({
                id: ++this.bidIdCounter,
                name: this.newBid.name.trim(),
                price: parseFloat(this.newBid.price)
            });

            this.newBid = { name: '', price: null };
        },

        /**
         * 删除报价
         */
        removeBid(id) {
            this.bids = this.bids.filter(b => b.id !== id);
        },

        /**
         * 清空所有报价
         */
        clearBids() {
            this.bids = [];
            this.currentScenarioId = null;
        },

        // ========== 方案数据规范化 ==========

        /**
         * 规范化配置，确保保存、更新、载入以及对比计算使用同一套数据结构
         */
        normalizeConfig(config) {
            const source = config && typeof config === 'object' ? config : {};
            const defaults = createDefaultConfig();

            const requiredNumber = (value, fallback) => {
                const number = Number(value);
                return Number.isFinite(number) ? number : fallback;
            };

            const optionalLimit = value => {
                if (value === null || value === undefined || value === '') return null;
                const number = Number(value);
                return Number.isFinite(number) ? number : null;
            };

            return {
                mode: source.mode === 'double' ? 'double' : 'single',
                maxPrice: optionalLimit(source.maxPrice),
                minPrice: optionalLimit(source.minPrice),
                fullScore: requiredNumber(source.fullScore, defaults.fullScore),
                deductUp: requiredNumber(source.deductUp, defaults.deductUp),
                deductDown: requiredNumber(source.deductDown, defaults.deductDown),
                minScore: requiredNumber(source.minScore, defaults.minScore),
                lowestWeight: requiredNumber(source.lowestWeight, defaults.lowestWeight)
            };
        },

        /**
         * 规范化单条报价
         */
        normalizeBid(bid, fallbackId) {
            if (!bid || typeof bid !== 'object') {
                throw new Error('报价数据无效');
            }

            const id = Number.isInteger(bid.id) && bid.id > 0 ? bid.id : fallbackId;
            const name = String(bid.name || '').trim();
            const price = Number(bid.price);

            if (!Number.isInteger(id) || id <= 0) {
                throw new Error('报价ID无效');
            }
            if (!name) {
                throw new Error('报价单位名称不能为空');
            }
            if (!Number.isFinite(price) || price <= 0) {
                throw new Error('报价金额无效');
            }

            return { id, name, price };
        },

        /**
         * 从当前编辑区生成一份独立、规范的方案快照
         */
        createSnapshot() {
            if (!Array.isArray(this.bids) || this.bids.length === 0) {
                throw new Error('方案中至少需要一条报价');
            }

            const config = this.normalizeConfig(this.config);
            const bids = [];
            const bidIds = new Set();
            const existingMaxId = Math.max(
                0,
                ...this.bids
                    .filter(bid => Number.isInteger(bid?.id) && bid.id > 0)
                    .map(bid => bid.id)
            );
            let workingBidIdCounter = Math.max(this.bidIdCounter, existingMaxId);

            this.bids.forEach(bid => {
                const id = Number.isInteger(bid?.id) && bid.id > 0
                    ? bid.id
                    : ++workingBidIdCounter;
                const normalizedBid = this.normalizeBid(bid, id);

                if (bidIds.has(normalizedBid.id)) {
                    throw new Error('报价ID重复');
                }

                bidIds.add(normalizedBid.id);
                bids.push(normalizedBid);
            });

            return {
                config,
                bids,
                bidIdCounter: workingBidIdCounter
            };
        },

        /**
         * 规范化已保存或导入的方案。所有校验先完成，再由调用方提交状态。
         */
        normalizeScenario(rawScenario, options = {}) {
            if (!rawScenario || typeof rawScenario !== 'object') {
                throw new Error('方案数据无效');
            }

            const id = Number.isInteger(options.id) && options.id > 0 ? options.id : null;
            const remapBids = options.remapBids === true;
            let workingBidIdCounter = Number.isInteger(options.bidIdCounter) && options.bidIdCounter >= 0
                ? options.bidIdCounter
                : this.bidIdCounter;

            const name = String(rawScenario.name || '').trim();
            if (!name) {
                throw new Error('方案名称不能为空');
            }

            const config = this.normalizeConfig(rawScenario.config);
            if (!Array.isArray(rawScenario.bids) || rawScenario.bids.length === 0) {
                throw new Error('方案中至少需要一条报价');
            }

            const bids = [];
            const bidIds = new Set();

            rawScenario.bids.forEach(bid => {
                const normalizedBid = this.normalizeBid(bid, null);
                const bidId = remapBids ? ++workingBidIdCounter : normalizedBid.id;

                if (bidIds.has(bidId)) {
                    throw new Error('方案内报价ID重复');
                }

                bidIds.add(bidId);
                bids.push({ ...normalizedBid, id: bidId });
            });

            const timestamp = value => {
                if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
                return new Date().toISOString();
            };

            return {
                id,
                name,
                config,
                bids,
                bidIdCounter: remapBids
                    ? workingBidIdCounter
                    : Math.max(Number(rawScenario.bidIdCounter) || 0, ...bids.map(bid => bid.id)),
                createdAt: timestamp(rawScenario.createdAt),
                updatedAt: timestamp(rawScenario.updatedAt || rawScenario.createdAt)
            };
        },

        // ========== 方案管理方法 ==========

        /**
         * 保存当前方案
         */
        saveScenario() {
            const name = this.newScenarioName.trim();
            if (!name || this.bids.length === 0) return false;

            let snapshot;
            try {
                snapshot = this.createSnapshot();
            } catch (err) {
                console.error('保存方案失败:', err);
                return false;
            }

            const now = new Date().toISOString();
            const scenario = {
                id: ++this.scenarioIdCounter,
                name,
                ...deepClone(snapshot),
                createdAt: now,
                updatedAt: now
            };

            this.scenarios.push(scenario);
            this.config = deepClone(scenario.config);
            this.bids = deepClone(scenario.bids);
            this.bidIdCounter = scenario.bidIdCounter;
            this.currentScenarioId = scenario.id;
            this.lastSavedScenarioId = scenario.id;
            this.newScenarioName = '';
            this.persistState();

            return true;
        },

        /**
         * 更新当前方案
         */
        updateScenario() {
            if (!this.currentScenarioId) return false;

            const index = this.scenarios.findIndex(s => s.id === this.currentScenarioId);
            if (index === -1) return false;

            let snapshot;
            try {
                snapshot = this.createSnapshot();
            } catch (err) {
                console.error('更新方案失败:', err);
                return false;
            }

            const updatedScenario = {
                ...this.scenarios[index],
                ...deepClone(snapshot),
                updatedAt: new Date().toISOString()
            };

            this.scenarios.splice(index, 1, updatedScenario);
            this.config = deepClone(updatedScenario.config);
            this.bids = deepClone(updatedScenario.bids);
            this.bidIdCounter = updatedScenario.bidIdCounter;
            this.currentScenarioId = updatedScenario.id;
            this.lastSavedScenarioId = updatedScenario.id;
            this.persistState();

            return true;
        },

        /**
         * 载入方案。先校验并生成完整快照，成功后才替换当前编辑区数据。
         */
        loadScenario(id) {
            const scenario = this.scenarios.find(s => s.id === id);
            if (!scenario) return false;

            let snapshot;
            try {
                snapshot = this.normalizeScenario(scenario, { id: scenario.id });
            } catch (err) {
                console.error('载入方案失败:', err);
                return false;
            }

            this.config = deepClone(snapshot.config);
            this.bids = deepClone(snapshot.bids);
            this.bidIdCounter = Math.max(this.bidIdCounter, snapshot.bidIdCounter);
            this.currentScenarioId = snapshot.id;
            this.compareMode = false;
            this.compareScenarioIds = [];

            return true;
        },

        /**
         * 删除方案
         */
        deleteScenario(id) {
            this.scenarios = this.scenarios.filter(s => s.id !== id);
            this.compareScenarioIds = this.compareScenarioIds.filter(sid => sid !== id);
            if (this.currentScenarioId === id) {
                this.currentScenarioId = null;
            }
            if (this.lastSavedScenarioId === id) {
                this.lastSavedScenarioId = null;
            }
            if (this.compareScenarioIds.length < 2) {
                this.compareMode = false;
            }
            this.persistState();
        },

        /**
         * 切换方案对比选择
         */
        toggleCompareScenario(id) {
            const index = this.compareScenarioIds.indexOf(id);
            if (index > -1) {
                this.compareScenarioIds.splice(index, 1);
            } else {
                if (this.compareScenarioIds.length < 4) {
                    this.compareScenarioIds.push(id);
                }
            }
            this.compareMode = this.compareScenarioIds.length >= 2;
        },

        // ========== 持久化 ==========

        /**
         * 保存方案库。当前未保存的临时编辑不写入，刷新后回到最近一次保存的方案。
         */
        persistState() {
            if (typeof localStorage === 'undefined') return;

            try {
                localStorage.setItem(BID_CALCULATOR_STORAGE_KEY, JSON.stringify({
                    version: 1,
                    scenarios: this.scenarios,
                    scenarioIdCounter: this.scenarioIdCounter,
                    bidIdCounter: this.bidIdCounter,
                    lastSavedScenarioId: this.lastSavedScenarioId
                }));
            } catch (err) {
                console.error('方案持久化失败:', err);
            }
        },

        /**
         * 从本地存储恢复方案，并载入最近一次保存或更新的方案
         */
        restoreState() {
            if (typeof localStorage === 'undefined') return;

            let saved;
            try {
                saved = JSON.parse(localStorage.getItem(BID_CALCULATOR_STORAGE_KEY) || 'null');
            } catch (err) {
                console.error('读取本地方案失败:', err);
                return;
            }

            if (!saved || !Array.isArray(saved.scenarios) || saved.scenarios.length === 0) {
                return;
            }

            const rawIds = saved.scenarios.map(scenario => {
                const id = Number(scenario?.id);
                return Number.isInteger(id) && id > 0 ? id : null;
            });
            const preserveScenarioIds = rawIds.every(id => id !== null)
                && new Set(rawIds).size === rawIds.length;
            const idMap = new Map();

            let workingBidIdCounter = Number.isInteger(saved.bidIdCounter) && saved.bidIdCounter >= 0
                ? saved.bidIdCounter
                : 0;
            let restoredScenarioIdCounter = 0;
            const restoredScenarios = [];

            try {
                saved.scenarios.forEach((rawScenario, index) => {
                    const scenarioId = preserveScenarioIds ? rawIds[index] : index + 1;
                    idMap.set(Number(rawScenario?.id), scenarioId);

                    const scenario = this.normalizeScenario(rawScenario, {
                        id: scenarioId,
                        remapBids: true,
                        bidIdCounter: workingBidIdCounter
                    });

                    workingBidIdCounter = scenario.bidIdCounter;
                    restoredScenarioIdCounter = Math.max(restoredScenarioIdCounter, scenarioId);
                    restoredScenarios.push(scenario);
                });
            } catch (err) {
                console.error('恢复本地方案失败:', err);
                return;
            }

            this.scenarios = restoredScenarios;
            this.scenarioIdCounter = Math.max(
                restoredScenarioIdCounter,
                Number(saved.scenarioIdCounter) || 0
            );
            this.bidIdCounter = workingBidIdCounter;

            const preferredId = idMap.get(Number(saved.lastSavedScenarioId));
            const targetScenario = this.scenarios.find(s => s.id === preferredId)
                || this.getLatestScenario();

            if (targetScenario) {
                this.lastSavedScenarioId = targetScenario.id;
                this.loadScenario(targetScenario.id);
            }
        },

        /**
         * 获取最近保存或更新的方案
         */
        getLatestScenario() {
            return this.scenarios.slice().sort((a, b) => {
                const timeA = Date.parse(a.updatedAt || a.createdAt) || 0;
                const timeB = Date.parse(b.updatedAt || b.createdAt) || 0;
                return timeB - timeA || b.id - a.id;
            })[0] || null;
        },

        // ========== 纯计算逻辑 ==========

        /**
         * 检查报价是否有效（限价判断）
         * - 超过上限价 → 废标
         * - 低于下限价 → 废标
         */
        checkValidity(price, config = this.config) {
            if (config.maxPrice !== null && config.maxPrice !== '' && price > config.maxPrice) {
                return { valid: false, reason: '超上限' };
            }
            if (config.minPrice !== null && config.minPrice !== '' && price < config.minPrice) {
                return { valid: false, reason: '低下限' };
            }
            return { valid: true, reason: '' };
        },

        /**
         * 获取指定配置和报价下的所有有效报价
         */
        getValidBidsFor(config, bids) {
            return bids.filter(bid => this.checkValidity(bid.price, config).valid);
        },

        /**
         * 获取所有有效报价
         */
        get validBids() {
            return this.getValidBidsFor(this.config, this.bids);
        },

        /**
         * 有效报价数量
         */
        get validBidsCount() {
            return this.getValidBidsFor(this.config, this.bids).length;
        },

        /**
         * 最低有效报价
         */
        getLowestValidPriceFor(config, bids) {
            const validBids = this.getValidBidsFor(config, bids);
            if (validBids.length === 0) return null;
            return Math.min(...validBids.map(b => b.price));
        },

        /**
         * 最低有效报价
         */
        get lowestValidPrice() {
            return this.getLowestValidPriceFor(this.config, this.bids);
        },

        /**
         * 有效报价平均值
         */
        getAverageValidPriceFor(config, bids) {
            const validBids = this.getValidBidsFor(config, bids);
            if (validBids.length === 0) return null;
            const sum = validBids.reduce((acc, b) => acc + b.price, 0);
            return sum / validBids.length;
        },

        /**
         * 有效报价平均值
         */
        get averageValidPrice() {
            return this.getAverageValidPriceFor(this.config, this.bids);
        },

        /**
         * 计算指定配置和报价下的评标基准价
         */
        getBaselinePriceFor(config, bids) {
            const validBids = this.getValidBidsFor(config, bids);
            if (validBids.length === 0) return null;

            if (config.mode === 'single') {
                return this.getLowestValidPriceFor(config, bids);
            }

            const lowestWeight = config.lowestWeight / 100;
            const avgWeight = 1 - lowestWeight;
            return this.getLowestValidPriceFor(config, bids) * lowestWeight
                + this.getAverageValidPriceFor(config, bids) * avgWeight;
        },

        /**
         * 计算评标基准价
         */
        get baselinePrice() {
            return this.getBaselinePriceFor(this.config, this.bids);
        },

        /**
         * 计算偏离率
         */
        calculateDeviation(price, baseline) {
            if (!baseline) return 0;
            return ((price - baseline) / baseline) * 100;
        },

        /**
         * 计算扣分
         */
        calculateDeduction(price, baseline, config) {
            if (!baseline) return 0;

            const deviation = this.calculateDeviation(price, baseline);
            if (deviation > 0) {
                return deviation * config.deductUp;
            }
            if (deviation < 0) {
                return Math.abs(deviation) * config.deductDown;
            }
            return 0;
        },

        /**
         * 计算最终得分
         */
        calculateScore(price, baseline, config) {
            if (!baseline) return 0;

            const deduction = this.calculateDeduction(price, baseline, config);
            let score = config.fullScore - deduction;

            score = Math.max(score, config.minScore);
            score = Math.min(score, config.fullScore);

            return score;
        },

        /**
         * 根据指定配置和报价生成排序结果，不修改当前编辑区
         */
        buildSortedResults(config, bids) {
            const baseline = this.getBaselinePriceFor(config, bids);
            const results = bids.map(bid => {
                const validity = this.checkValidity(bid.price, config);
                const isValid = validity.valid;

                return {
                    id: bid.id,
                    name: bid.name,
                    price: bid.price,
                    isValid,
                    invalidReason: validity.reason,
                    deviation: isValid ? this.calculateDeviation(bid.price, baseline) : 0,
                    deduction: isValid ? this.calculateDeduction(bid.price, baseline, config) : 0,
                    score: isValid ? this.calculateScore(bid.price, baseline, config) : 0
                };
            });

            // 排序：有效报价在前，按得分降序；无效报价在后
            results.sort((a, b) => {
                if (a.isValid && !b.isValid) return -1;
                if (!a.isValid && b.isValid) return 1;
                if (!a.isValid && !b.isValid) return 0;
                if (b.score !== a.score) return b.score - a.score;
                return a.price - b.price;
            });

            // 添加排名（同分同名次，下一名次按实际位置顺延）
            let rank = 0;
            results.forEach((result, index) => {
                if (!result.isValid) {
                    result.rank = null;
                    return;
                }

                const previous = results[index - 1];
                if (index === 0 || !previous.isValid || previous.score !== result.score) {
                    rank = index + 1;
                }
                result.rank = rank;
            });

            return results;
        },

        /**
         * 排序后的结果（按得分降序）
         */
        get sortedResults() {
            return this.buildSortedResults(this.config, this.bids);
        },

        /**
         * 获取方案的计算结果（纯计算，不临时替换当前配置和报价）
         */
        getScenarioResults(scenario) {
            const config = deepClone(scenario.config);
            const bids = deepClone(scenario.bids);
            const validBids = this.getValidBidsFor(config, bids);

            return {
                scenarioId: scenario.id,
                scenarioName: scenario.name,
                config,
                baselinePrice: this.getBaselinePriceFor(config, bids),
                validBidsCount: validBids.length,
                lowestValidPrice: this.getLowestValidPriceFor(config, bids),
                averageValidPrice: this.getAverageValidPriceFor(config, bids),
                sortedResults: this.buildSortedResults(config, bids)
            };
        },

        /**
         * 获取对比的所有方案结果
         */
        get compareResults() {
            return this.compareScenarioIds.map(id => {
                const scenario = this.scenarios.find(s => s.id === id);
                return scenario ? this.getScenarioResults(scenario) : null;
            }).filter(Boolean);
        },

        /**
         * 获取所有投标人名称（用于对比表格）
         */
        get allBidderNames() {
            const names = new Set();
            this.compareResults.forEach(result => {
                result.sortedResults.forEach(r => names.add(r.name));
            });
            return Array.from(names);
        },

        /**
         * 获取投标人在指定方案中的数据
         */
        getBidderData(bidderName, scenarioResult) {
            return scenarioResult.sortedResults.find(r => r.name === bidderName);
        },

        /**
         * 导出方案数据
         */
        exportScenarios() {
            const data = {
                scenarios: this.scenarios,
                exportedAt: new Date().toISOString()
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `报价方案_${new Date().toLocaleDateString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        },

        /**
         * 导入方案数据。任一方案校验失败时，整批数据都不提交，也不影响当前编辑区。
         */
        importScenarios(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data || !Array.isArray(data.scenarios) || data.scenarios.length === 0) {
                        throw new Error('导入文件中没有方案');
                    }

                    let nextScenarioIdCounter = this.scenarioIdCounter;
                    let nextBidIdCounter = this.bidIdCounter;
                    const importedScenarios = [];

                    data.scenarios.forEach(rawScenario => {
                        const scenario = this.normalizeScenario(rawScenario, {
                            id: ++nextScenarioIdCounter,
                            remapBids: true,
                            bidIdCounter: nextBidIdCounter
                        });
                        nextBidIdCounter = scenario.bidIdCounter;
                        importedScenarios.push(scenario);
                    });

                    this.scenarios.push(...importedScenarios);
                    this.scenarioIdCounter = nextScenarioIdCounter;
                    this.bidIdCounter = Math.max(this.bidIdCounter, nextBidIdCounter);
                    this.persistState();
                } catch (err) {
                    console.error('导入失败:', err);
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }
    };
}
