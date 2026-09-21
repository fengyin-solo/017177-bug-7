/**
 * 投标报价计算器 - 核心逻辑
 */
function bidCalculator() {
    // ========== 持久化与快照工具（不依赖 this，可独立测试） ==========

    const STORAGE_KEY = 'bid-calculator-state-v1';

    // 默认配置（载入/重置时的唯一配置来源）
    function defaultConfig() {
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

    // 深拷贝（仅处理本应用的纯数据：对象/数组/原始值）
    function deepClone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    // 校验并规范化一份配置；非法时抛错（保证载入失败不会污染现有数据）
    function normalizeConfig(raw) {
        if (!raw || typeof raw !== 'object') throw new Error('配置缺失或格式错误');
        if (raw.mode !== 'single' && raw.mode !== 'double') throw new Error('评标模式无效');

        const base = defaultConfig();
        const config = Object.assign(base, raw);

        const numFields = ['maxPrice', 'minPrice', 'fullScore', 'deductUp', 'deductDown', 'minScore', 'lowestWeight'];
        numFields.forEach(field => {
            if (config[field] === null || config[field] === '' || config[field] === undefined) {
                config[field] = field === 'maxPrice' || field === 'minPrice' ? null : base[field];
                return;
            }
            const n = Number(config[field]);
            if (!Number.isFinite(n)) throw new Error(`参数 ${field} 不是有效数字`);
            config[field] = n;
        });
        return config;
    }

    // 校验并规范化一组报价
    function normalizeBids(raw) {
        if (!Array.isArray(raw)) throw new Error('报价列表格式错误');
        return raw.map((bid, index) => {
            if (!bid || typeof bid !== 'object') throw new Error(`第 ${index + 1} 条报价格式错误`);
            const name = String(bid.name == null ? '' : bid.name).trim();
            const price = Number(bid.price);
            if (!name) throw new Error(`第 ${index + 1} 条报价缺少单位名称`);
            if (!Number.isFinite(price) || price <= 0) throw new Error(`「${name}」的报价无效`);
            return { name, price };
        });
    }

    // 校验一整份方案快照；返回规范化后的方案（不含 id 之外的内部字段），非法则抛错
    function validateScenario(raw) {
        if (!raw || typeof raw !== 'object') throw new Error('方案格式错误');
        const config = normalizeConfig(raw.config);
        const bids = normalizeBids(raw.bids);
        const name = String(raw.name == null ? '' : raw.name).trim() || '未命名方案';
        return { name, config, bids };
    }

    /**
     * 纯函数：根据一份配置与报价计算完整结果。
     * 不读写任何组件状态 —— 保存 / 更新 / 载入 / 对比 / 右侧主面板全部走这一份逻辑，
     * 同一份配置与报价必然得到同一份名次与分数。
     */
    function computeResults(config, bids) {
        const checkValidity = (price) => {
            if (config.maxPrice !== null && price > config.maxPrice) {
                return { valid: false, reason: '超上限' };
            }
            if (config.minPrice !== null && price < config.minPrice) {
                return { valid: false, reason: '低下限' };
            }
            return { valid: true, reason: '' };
        };

        const validBids = bids.filter(bid => checkValidity(bid.price).valid);
        const validBidsCount = validBids.length;
        const lowestValidPrice = validBids.length ? Math.min(...validBids.map(b => b.price)) : null;
        const averageValidPrice = validBids.length
            ? validBids.reduce((acc, b) => acc + b.price, 0) / validBids.length
            : null;

        let baselinePrice = null;
        if (validBids.length) {
            if (config.mode === 'single') {
                baselinePrice = lowestValidPrice;
            } else {
                const lowestWeight = config.lowestWeight / 100;
                baselinePrice = lowestValidPrice * lowestWeight + averageValidPrice * (1 - lowestWeight);
            }
        }

        const calculateDeviation = (price) => {
            if (!baselinePrice) return 0;
            return ((price - baselinePrice) / baselinePrice) * 100;
        };
        const calculateScore = (price) => {
            if (!baselinePrice) return 0;
            const deviation = calculateDeviation(price);
            const deduction = deviation > 0
                ? deviation * config.deductUp
                : Math.abs(deviation) * config.deductDown;
            let score = config.fullScore - deduction;
            score = Math.max(score, config.minScore);
            score = Math.min(score, config.fullScore);
            return score;
        };

        // 排序：有效在前按得分降序、同分低价在前；无效在后
        const results = bids.map(bid => {
            const validity = checkValidity(bid.price);
            if (!validity.valid) {
                return {
                    id: bid.id,
                    name: bid.name,
                    price: bid.price,
                    isValid: false,
                    invalidReason: validity.reason,
                    deviation: 0,
                    deduction: 0,
                    score: 0
                };
            }
            const deviation = calculateDeviation(bid.price);
            const deduction = deviation > 0
                ? deviation * config.deductUp
                : Math.abs(deviation) * config.deductDown;
            return {
                id: bid.id,
                name: bid.name,
                price: bid.price,
                isValid: true,
                invalidReason: '',
                deviation,
                deduction,
                score: calculateScore(bid.price)
            };
        });

        results.sort((a, b) => {
            if (a.isValid && !b.isValid) return -1;
            if (!a.isValid && b.isValid) return 1;
            if (!a.isValid && !b.isValid) {
                // 无效报价之间保持稳定顺序，避免切换方案时名次/顺序跳动
                return (a.id || 0) - (b.id || 0);
            }
            if (b.score !== a.score) return b.score - a.score;
            if (a.price !== b.price) return a.price - b.price;
            return (a.id || 0) - (b.id || 0);
        });

        // 同分同名次（标准并列排名 1,1,1,4）
        let rank = 0;
        let lastScore = null;
        let skipCount = 0;
        results.forEach(r => {
            if (!r.isValid) {
                r.rank = null;
                return;
            }
            if (r.score !== lastScore) {
                rank = rank + 1 + skipCount;
                skipCount = 0;
            } else {
                skipCount++;
            }
            r.rank = rank;
            lastScore = r.score;
        });

        return {
            config,
            validBidsCount,
            lowestValidPrice,
            averageValidPrice,
            baselinePrice,
            sortedResults: results
        };
    }

    return {
        // 配置参数（当前工作区）
        config: defaultConfig(),

        // 投标报价列表（当前工作区）
        bids: [],

        // 新增报价表单
        newBid: {
            name: '',
            price: null
        },

        // 全局单调递增的报价ID：只增不减、不随方案快照回退，
        // 保证任意方案/任何时刻的报价都不会出现重复 key
        bidIdSeq: 0,

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

        // 方案ID计数器（同样全局单调递增，不做快照恢复）
        scenarioIdSeq: 0,

        /**
         * 初始化：从 localStorage 恢复工作区与已保存方案。
         * 任何恢复失败都退回到全新默认状态，绝不让坏数据进入运行时。
         */
        init() {
            let restored = null;
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) restored = JSON.parse(raw);
            } catch (err) {
                console.warn('读取本地保存数据失败，使用默认状态:', err);
            }

            if (restored && typeof restored === 'object') {
                try {
                    const scenarios = Array.isArray(restored.scenarios) ? restored.scenarios : [];
                    // 逐条校验：坏方案直接丢弃，不影响其余方案与工作区
                    this.scenarios = scenarios
                        .map(s => {
                            try {
                                const clean = validateScenario(s);
                                return {
                                    id: Number(s.id),
                                    name: clean.name,
                                    config: clean.config,
                                    bids: this._withBidIds(clean.bids),
                                    createdAt: s.createdAt || null,
                                    updatedAt: s.updatedAt || null
                                };
                            } catch (err) {
                                console.warn('忽略一条无法识别的本地方案:', err);
                                return null;
                            }
                        })
                        .filter(Boolean)
                        .filter(s => Number.isFinite(s.id));

                    if (this.scenarios.length) {
                        this.scenarioIdSeq = Math.max(...this.scenarios.map(s => s.id));
                    }

                    // 恢复工作区（上次最后一次保存或编辑时的配置与报价）
                    if (restored.workspace) {
                        const wsConfig = normalizeConfig(restored.workspace.config);
                        const wsBids = normalizeBids(restored.workspace.bids || []);
                        this.config = wsConfig;
                        this.bids = this._withBidIds(wsBids);
                    }
                    this.bidIdSeq = Number.isFinite(restored.bidIdSeq)
                        ? Math.max(restored.bidIdSeq, this.bids.reduce((m, b) => Math.max(m, b.id || 0), 0))
                        : this.bids.reduce((m, b) => Math.max(m, b.id || 0), 0);

                    const cid = Number(restored.currentScenarioId);
                    this.currentScenarioId = this.scenarios.some(s => s.id === cid) ? cid : null;
                } catch (err) {
                    console.warn('恢复工作区失败，使用默认状态:', err);
                    this.config = defaultConfig();
                    this.bids = [];
                    this.currentScenarioId = null;
                }
            }

            // 对比态属于临时视图状态，刷新后一律收起
            this.compareMode = false;
            this.compareScenarioIds = [];

            // 工作区任一变化都自动落盘（刷新后与最后一次保存/编辑一致）
            this.$watch('config', () => this.persist(), { deep: true });
            this.$watch('bids', () => this.persist(), { deep: true });
        },

        /**
         * 把整份工作区写入 localStorage
         */
        persist() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    scenarios: this.scenarios,
                    workspace: {
                        config: this.config,
                        bids: this.bids
                    },
                    currentScenarioId: this.currentScenarioId,
                    bidIdSeq: this.bidIdSeq
                }));
            } catch (err) {
                console.warn('保存到本地失败:', err);
            }
        },

        /**
         * 给一批纯报价数据补上运行时 id（全局单调，不随方案快照回退）
         */
        _withBidIds(plainBids) {
            return plainBids.map(b => ({
                id: Number.isFinite(b.id) ? b.id : ++this.bidIdSeq,
                name: b.name,
                price: b.price
            }));
        },

        /**
         * 生成一份当前工作区的不可变快照（保存与更新共用，保证三处同源）
         */
        _takeSnapshot() {
            // 先规范化当前 config / bids，确保存进去的一定是可用数据
            const config = normalizeConfig(deepClone(this.config));
            const plainBids = normalizeBids(deepClone(this.bids));
            return { config, bids: this._withBidIds(plainBids) };
        },

        /**
         * 添加报价
         */
        addBid() {
            if (!this.newBid.name || !this.newBid.price || this.newBid.price <= 0) return;

            this.bids.push({
                id: ++this.bidIdSeq,
                name: this.newBid.name.trim(),
                price: parseFloat(this.newBid.price)
            });

            this.newBid = { name: '', price: null };
            this.persist();
        },

        /**
         * 删除报价
         */
        removeBid(id) {
            this.bids = this.bids.filter(b => b.id !== id);
            this.persist();
        },

        /**
         * 清空所有报价（只是在编辑工作区操作，不触碰任何已保存方案）
         */
        clearBids() {
            this.bids = [];
            this.currentScenarioId = null;
            this.persist();
        },

        // ========== 方案管理方法 ==========

        /**
         * 保存当前方案（新建）
         */
        saveScenario() {
            if (!this.newScenarioName.trim()) return;
            if (this.bids.length === 0) return;

            const snapshot = this._takeSnapshot();
            const now = new Date().toISOString();
            const scenario = {
                id: ++this.scenarioIdSeq,
                name: this.newScenarioName.trim(),
                config: snapshot.config,
                bids: snapshot.bids,
                createdAt: now,
                updatedAt: now
            };

            this.scenarios.push(scenario);
            this.currentScenarioId = scenario.id;
            this.newScenarioName = '';
            this.persist();
        },

        /**
         * 更新当前方案：用当前工作区的同一份配置与报价覆盖快照
         */
        updateScenario() {
            if (!this.currentScenarioId) return;

            const scenario = this.scenarios.find(s => s.id === this.currentScenarioId);
            if (!scenario) {
                this.currentScenarioId = null;
                return;
            }

            // 快照生成失败（当前数据不合法）时不覆盖原方案
            let snapshot;
            try {
                snapshot = this._takeSnapshot();
            } catch (err) {
                console.warn('当前数据无法更新到方案:', err);
                return;
            }

            scenario.config = snapshot.config;
            scenario.bids = snapshot.bids;
            scenario.updatedAt = new Date().toISOString();
            this.persist();
        },

        /**
         * 加载方案。
         * 成功才整体替换工作区；任何一步失败都保留原有数据，返回 false。
         */
        loadScenario(id) {
            const scenario = this.scenarios.find(s => s.id === id);
            if (!scenario) return false;

            // 1) 先在临时变量上完成校验与克隆，全程不动现有工作区
            let config, bids;
            try {
                const clean = validateScenario({
                    name: scenario.name,
                    config: scenario.config,
                    bids: scenario.bids
                });
                config = clean.config;
                // 保留方案保存时的 id；若历史数据缺 id 则补发全局唯一 id
                bids = clean.bids.map((b, i) => ({
                    id: Number.isFinite(scenario.bids[i] && scenario.bids[i].id)
                        ? scenario.bids[i].id
                        : ++this.bidIdSeq,
                    name: b.name,
                    price: b.price
                }));
            } catch (err) {
                console.warn('方案载入失败，保留当前数据:', err);
                return false;
            }

            // 2) 校验通过后一次性提交
            this.config = config;
            this.bids = bids;
            this.bidIdSeq = Math.max(this.bidIdSeq, ...bids.map(b => b.id));
            this.currentScenarioId = id;
            this.compareMode = false;
            this.compareScenarioIds = [];
            this.persist();
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
            if (this.compareScenarioIds.length < 2) {
                this.compareMode = false;
            }
            this.persist();
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

        /**
         * 获取方案的计算结果 —— 纯计算，绝不换入/换出 this.config、this.bids，
         * 因此对比面板的渲染不可能污染右侧主面板，也不影响未保存的临时编辑。
         */
        getScenarioResults(scenario) {
            const computed = computeResults(
                deepClone(scenario.config),
                deepClone(scenario.bids)
            );
            return {
                scenarioId: scenario.id,
                scenarioName: scenario.name,
                config: computed.config,
                baselinePrice: computed.baselinePrice,
                validBidsCount: computed.validBidsCount,
                lowestValidPrice: computed.lowestValidPrice,
                averageValidPrice: computed.averageValidPrice,
                sortedResults: computed.sortedResults
            };
        },

        /**
         * 获取对比的所有方案结果（结构异常的方案跳过，不影响其余方案与主面板）
         */
        get compareResults() {
            return this.compareScenarioIds.map(id => {
                const scenario = this.scenarios.find(s => s.id === id);
                if (!scenario) return null;
                try {
                    return this.getScenarioResults(scenario);
                } catch (err) {
                    console.warn('方案计算失败，已在对比中跳过:', err);
                    return null;
                }
            }).filter(Boolean);
        },

        /**
         * 获取所有投标人名称（用于对比表格，按出现顺序去重）
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
                version: 1,
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
         * 导入方案数据：逐条校验，合法才入库，坏数据丢弃
         */
        importScenarios(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                let imported;
                try {
                    imported = JSON.parse(e.target.result);
                } catch (err) {
                    console.error('导入失败：文件不是有效的 JSON:', err);
                    return;
                }

                const list = Array.isArray(imported) ? imported
                    : (imported && Array.isArray(imported.scenarios)) ? imported.scenarios : null;
                if (!list) {
                    console.error('导入失败：未找到方案列表');
                    return;
                }

                let okCount = 0;
                list.forEach(raw => {
                    try {
                        const clean = validateScenario(raw);
                        const now = new Date().toISOString();
                        this.scenarios.push({
                            id: ++this.scenarioIdSeq,
                            name: clean.name,
                            config: clean.config,
                            bids: this._withBidIds(clean.bids),
                            createdAt: raw.createdAt || now,
                            updatedAt: raw.updatedAt || now
                        });
                        okCount++;
                    } catch (err) {
                        console.warn('跳过一条无法导入的方案:', err);
                    }
                });
                if (okCount > 0) this.persist();
            };
            reader.readAsText(file);
            event.target.value = '';
        },

        // ========== 以下 getter 全部基于当前工作区，经同一份 computeResults 计算 ==========

        /**
         * 检查报价是否有效（限价判断）
         */
        checkValidity(price) {
            if (this.config.maxPrice !== null && this.config.maxPrice !== '' && price > this.config.maxPrice) {
                return { valid: false, reason: '超上限' };
            }
            if (this.config.minPrice !== null && this.config.minPrice !== '' && price < this.config.minPrice) {
                return { valid: false, reason: '低下限' };
            }
            return { valid: true, reason: '' };
        },

        /**
         * 获取所有有效报价
         */
        get validBids() {
            return this.bids.filter(bid => this.checkValidity(bid.price).valid);
        },

        get validBidsCount() {
            return this.validBids.length;
        },

        get lowestValidPrice() {
            if (this.validBids.length === 0) return null;
            return Math.min(...this.validBids.map(b => b.price));
        },

        get averageValidPrice() {
            if (this.validBids.length === 0) return null;
            const sum = this.validBids.reduce((acc, b) => acc + b.price, 0);
            return sum / this.validBids.length;
        },

        /**
         * 评标基准价
         */
        get baselinePrice() {
            return computeResults(this.config, this.bids).baselinePrice;
        },

        calculateDeviation(price) {
            const baseline = computeResults(this.config, this.bids).baselinePrice;
            if (!baseline) return 0;
            return ((price - baseline) / baseline) * 100;
        },

        calculateDeduction(price) {
            const deviation = this.calculateDeviation(price);
            if (deviation > 0) return deviation * this.config.deductUp;
            if (deviation < 0) return Math.abs(deviation) * this.config.deductDown;
            return 0;
        },

        calculateScore(price) {
            const baseline = computeResults(this.config, this.bids).baselinePrice;
            if (!baseline) return 0;
            const deviation = this.calculateDeviation(price);
            const deduction = deviation > 0
                ? deviation * this.config.deductUp
                : Math.abs(deviation) * this.config.deductDown;
            let score = this.config.fullScore - deduction;
            score = Math.max(score, this.config.minScore);
            score = Math.min(score, this.config.fullScore);
            return score;
        },

        /**
         * 排序后的结果（与方案保存/对比走同一个纯函数，名次分数保证一致）
         */
        get sortedResults() {
            return computeResults(this.config, this.bids).sortedResults;
        }
    };
}
