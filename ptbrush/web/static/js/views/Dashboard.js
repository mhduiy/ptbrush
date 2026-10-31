import { defineComponent, computed, reactive, ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { formatBytes, formatSpeed, formatGiB, truncate } from '../utils.js';

const TIME_OPTIONS = [
    { value: 10, label: '10分钟' },
    { value: 30, label: '30分钟' },
    { value: 60, label: '1小时' },
    { value: 360, label: '6小时' },
    { value: 1440, label: '24小时' },
];

const TASK_STATES = {
    idle: { label: '待执行', type: 'info' },
    running: { label: '运行中', type: 'warning' },
    succeeded: { label: '执行结束', type: 'success' },
    skipped: { label: '已跳过', type: 'warning' },
    failed: { label: '执行失败', type: 'danger' },
};

export default defineComponent({
    name: 'Dashboard',
    setup() {
        const stats = reactive({
            upspeed: 0,
            dlspeed: 0,
            up_total: 0,
            dl_total: 0,
            free_space: 0,
            timestamp: '',
        });
        const torrents = ref([]);
        const totalActive = ref(0);
        const selectedRange = ref(10);
        const health = ref({ ok: true, missing: [] });
        const dataErrors = reactive({ stats: '', health: '', history: '' });
        const visibleErrors = computed(() => Object.values(dataErrors).filter(Boolean));
        const task = ref(null);
        const submitting = ref(false);
        const taskError = ref('');
        const submitError = ref('');
        const taskState = computed(() => {
            if (submitting.value) return { label: '正在提交', type: 'info' };
            if (!task.value) return { label: taskError.value ? '状态未知' : '正在读取状态', type: 'info' };
            return TASK_STATES[task.value.running ? 'running' : task.value.status];
        });
        let taskTimer = null;
        let taskLoading = false;
        let taskVersion = 0;
        let disposed = false;

        async function loadTask() {
            if (disposed || taskLoading || submitting.value) return;
            taskLoading = true;
            const version = taskVersion;
            try {
                const data = await api.get('/api/tasks/brush');
                if (disposed || version !== taskVersion) return;
                if (typeof data?.running !== 'boolean' || !Object.hasOwn(TASK_STATES, data.status)) {
                    throw new Error('任务状态接口返回格式异常');
                }
                task.value = data;
                taskError.value = '';
            } catch (e) {
                if (!disposed && version === taskVersion) taskError.value = e.message || '读取任务状态失败';
            } finally {
                taskLoading = false;
                if (!disposed && !submitting.value) taskTimer = setTimeout(loadTask, 2000);
            }
        }

        async function runOnce() {
            if (submitting.value || !task.value || task.value.running || taskError.value) return;
            submitting.value = true;
            submitError.value = '';
            clearTimeout(taskTimer);
            taskVersion += 1;
            try {
                const data = await api.post('/api/tasks/brush', {});
                if (disposed) return;
                if (typeof data?.running !== 'boolean' || !Object.hasOwn(TASK_STATES, data.status)) {
                    throw new Error('任务提交接口返回格式异常');
                }
                task.value = data;
                taskError.value = '';
            } catch (e) {
                if (disposed) return;
                submitError.value = e.message || '提交执行任务失败';
                if (e.status === 409) {
                    task.value = {
                        running: true, status: 'running', message: '已有任务正在运行，正在同步状态。',
                        started_at: null, finished_at: null,
                    };
                }
            } finally {
                if (!disposed) {
                    submitting.value = false;
                    loadTask();
                }
            }
        }

        async function loadStats() {
            try {
                const data = await api.get('/api/stats');
                Object.assign(stats, data.status);
                torrents.value = data.torrents;
                totalActive.value = data.total_active;
                dataErrors.stats = '';
            } catch (e) {
                dataErrors.stats = `加载统计数据失败：${e.message || '请求失败'}`;
            }
        }

        async function loadHealth() {
            try {
                health.value = await api.get('/api/config/health');
                dataErrors.health = '';
            } catch (e) {
                dataErrors.health = `加载配置检查失败：${e.message || '请求失败'}`;
            }
        }

        async function loadHistory(minutes) {
            try {
                const data = await api.get(`/api/history?minutes=${minutes}`);
                const plotData = [
                    {
                        x: data.timestamps,
                        y: data.upspeed.map(s => s / (1024 * 1024)),
                        type: 'scatter', mode: 'lines',
                        name: '上传速度 (MiB/s)',
                        line: { color: '#67c23a' },
                    },
                    {
                        x: data.timestamps,
                        y: data.dlspeed.map(s => s / (1024 * 1024)),
                        type: 'scatter', mode: 'lines',
                        name: '下载速度 (MiB/s)',
                        line: { color: '#409eff' },
                    },
                ];
                const layout = {
                    margin: { l: 50, r: 30, t: 30, b: 60 },
                    xaxis: { title: '时间', automargin: true },
                    yaxis: { title: '速度 (MiB/s)' },
                    legend: { orientation: 'h', y: 1.15 },
                };
                window.Plotly.newPlot('speedChart', plotData, layout, { responsive: true });
                dataErrors.history = '';
            } catch (e) {
                dataErrors.history = `加载历史数据失败：${e.message || '请求失败'}`;
            }
        }

        function selectRange(value) {
            selectedRange.value = value;
            loadHistory(value);
        }

        let statsTimer = null;
        let historyTimer = null;

        onMounted(() => {
            loadStats();
            loadHistory(selectedRange.value);
            loadHealth();
            loadTask();
            statsTimer = setInterval(loadStats, 10000);
            historyTimer = setInterval(() => loadHistory(selectedRange.value), 60000);
        });

        onUnmounted(() => {
            disposed = true;
            clearTimeout(taskTimer);
            if (statsTimer) clearInterval(statsTimer);
            if (historyTimer) clearInterval(historyTimer);
            if (window.Plotly) window.Plotly.purge('speedChart');
        });

        return {
            stats,
            torrents,
            totalActive,
            selectedRange,
            health,
            visibleErrors,
            task,
            submitting,
            taskError,
            submitError,
            taskState,
            runOnce,
            timeOptions: TIME_OPTIONS,
            selectRange,
            formatBytes,
            formatSpeed,
            formatGiB,
            truncate,
        };
    },
    template: `
        <div>
            <el-alert v-for="message in visibleErrors" :key="message" class="page-alert"
                type="error" show-icon :closable="false" :title="message" />
            <el-card class="task-panel" shadow="hover">
                <template #header>
                    <div class="card-header-row">
                        <span>手动执行刷流</span>
                        <div class="task-status">
                            <el-tag :type="taskState.type" role="status">{{ taskState.label }}</el-tag>
                            <router-link to="/logs">查看运行日志 →</router-link>
                            <el-button type="primary" :loading="submitting"
                                :disabled="submitting || !task || task.running || !!taskError" @click="runOnce">
                                立即执行一次
                            </el-button>
                        </div>
                    </div>
                </template>
                <el-alert v-if="taskError" class="page-alert" type="error" show-icon :closable="false"
                    :title="taskError" description="任务状态每 2 秒自动重试，恢复后可继续操作。" />
                <el-alert v-if="submitError" class="page-alert" type="error" show-icon :closable="false" :title="submitError" />
                <p class="field-help task-help">立即执行会先刷新 qBittorrent 状态并抓取 FREE 种子；忽略工作时段，仍遵守磁盘空间、速度及种子数量安全限制。</p>
                <p v-if="task && (task.message || task.status === 'failed')" class="task-message"
                    :class="{ 'task-failed': task.status === 'failed' }" role="status">
                    {{ task.message || '本次执行失败，请查看运行日志。' }}
                </p>
                <div v-if="task && (task.started_at || task.finished_at)" class="field-help task-times">
                    <span v-if="task.started_at">开始：{{ task.started_at }}</span>
                    <span v-if="task.finished_at">结束：{{ task.finished_at }}</span>
                </div>
            </el-card>
            <el-alert
                v-if="!health.ok && health.missing?.length"
                type="warning"
                show-icon
                :closable="false"
                style="margin-bottom:16px;"
                title="配置不完整，刷流功能可能无法工作">
                <template #default>
                    <div>缺失字段：<el-tag v-for="m in health.missing" :key="m" type="warning" size="small" style="margin-right:4px;">{{ m }}</el-tag></div>
                    <router-link to="/config" style="color:#e6a23c;text-decoration:underline;">前往配置页填写 →</router-link>
                </template>
            </el-alert>

            <el-row :gutter="16">
                <el-col :xs="12" :sm="6" v-for="card in [
                    { label: '上传速度', unit: 'MiB/s', val: formatSpeed(stats.upspeed) },
                    { label: '下载速度', unit: 'MiB/s', val: formatSpeed(stats.dlspeed) },
                    { label: '活跃种子数', unit: '', val: totalActive },
                    { label: '剩余空间', unit: 'GiB', val: formatGiB(stats.free_space) }
                ]" :key="card.label">
                    <el-card class="stat-card" shadow="hover">
                        <div class="stat-value">{{ card.val }}</div>
                        <div class="stat-label">
                            {{ card.label }}
                            <span class="speed-unit" v-if="card.unit">({{ card.unit }})</span>
                        </div>
                    </el-card>
                </el-col>
            </el-row>

            <el-card class="mt-4" shadow="hover" style="margin-top:16px;">
                <template #header>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span>速度历史</span>
                        <el-radio-group :model-value="selectedRange" @update:model-value="selectRange" size="small">
                            <el-radio-button
                                v-for="opt in timeOptions"
                                :key="opt.value"
                                :label="opt.value">
                                {{ opt.label }}
                            </el-radio-button>
                        </el-radio-group>
                    </div>
                </template>
                <div id="speedChart"></div>
            </el-card>

            <el-card class="mt-4" shadow="hover" style="margin-top:16px;">
                <template #header>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span>活跃种子</span>
                        <span style="color:#909399;font-size:12px;">
                            最后更新: {{ stats.timestamp || '-' }}
                        </span>
                    </div>
                </template>
                <el-table :data="torrents" stripe size="small">
                    <el-table-column label="名称" min-width="240">
                        <template #default="{ row }">
                            <el-tooltip :content="row.name" placement="top" :show-after="300">
                                <span>{{ truncate(row.name, 36) }}</span>
                            </el-tooltip>
                        </template>
                    </el-table-column>
                    <el-table-column prop="site" label="站点" width="100" />
                    <el-table-column label="上传速度" width="110">
                        <template #default="{ row }">{{ formatSpeed(row.upspeed) }} MiB/s</template>
                    </el-table-column>
                    <el-table-column label="下载速度" width="110">
                        <template #default="{ row }">{{ formatSpeed(row.dlspeed) }} MiB/s</template>
                    </el-table-column>
                    <el-table-column label="已上传" width="110">
                        <template #default="{ row }">{{ formatBytes(row.up_total) }}</template>
                    </el-table-column>
                    <el-table-column label="已下载" width="110">
                        <template #default="{ row }">{{ formatBytes(row.dl_total) }}</template>
                    </el-table-column>
                    <el-table-column prop="free_end_time" label="Free 截止" width="170" />
                    <el-table-column prop="score" label="分数" width="70" />
                    <template #empty>
                        <span style="color:#909399;">暂无活跃种子</span>
                    </template>
                </el-table>
            </el-card>
        </div>
    `,
});
