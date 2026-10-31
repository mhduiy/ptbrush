import { defineComponent, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';

const MAX_LOG_CHARS = 200000;

export default defineComponent({
    name: 'Logs',
    setup() {
        const text = ref('');
        const error = ref('');
        const paused = ref(false);
        const autoScroll = ref(true);
        const loading = ref(false);
        const truncated = ref(false);
        const rotated = ref(false);
        const lastUpdated = ref('');
        const logViewport = ref(null);
        let cursor = null;
        let timer = null;
        let inFlight = false;
        let disposed = false;
        let displayVersion = 0;

        async function scrollToBottom() {
            await nextTick();
            if (!disposed && autoScroll.value && logViewport.value) {
                logViewport.value.scrollTop = logViewport.value.scrollHeight;
            }
        }

        async function loadLogs() {
            if (disposed || paused.value || inFlight) return;
            inFlight = true;
            loading.value = true;
            const version = displayVersion;
            const hadCursor = Boolean(cursor);
            try {
                const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
                const data = await api.get(`/api/logs${query}`);
                if (disposed || paused.value) return;
                if (typeof data?.text !== 'string' || typeof data.cursor !== 'string' || typeof data.reset !== 'boolean') {
                    throw new Error('日志接口返回格式异常');
                }
                cursor = data.cursor;
                if (version === displayVersion) {
                    if (data.reset) {
                        text.value = '';
                        truncated.value = false;
                        rotated.value = hadCursor;
                    }
                    // ponytail: 仅保留最近 20 万字符；需要完整历史时读取服务器日志文件。
                    const combined = text.value + data.text;
                    if (combined.length > MAX_LOG_CHARS) truncated.value = true;
                    text.value = combined.slice(-MAX_LOG_CHARS);
                    await scrollToBottom();
                }
                if (disposed) return;
                error.value = '';
                lastUpdated.value = new Date().toLocaleTimeString();
            } catch (e) {
                if (!disposed) error.value = e.message || '读取运行日志失败';
            } finally {
                inFlight = false;
                if (!disposed) {
                    loading.value = false;
                    if (!paused.value) timer = setTimeout(loadLogs, 2000);
                }
            }
        }

        function togglePaused() {
            paused.value = !paused.value;
            clearTimeout(timer);
            if (!paused.value) loadLogs();
        }

        function clearDisplay() {
            displayVersion += 1;
            text.value = '';
            truncated.value = false;
            rotated.value = false;
        }

        watch(autoScroll, scrollToBottom);
        onMounted(loadLogs);
        onUnmounted(() => {
            disposed = true;
            clearTimeout(timer);
            cursor = null;
            text.value = '';
            error.value = '';
            lastUpdated.value = '';
            loading.value = false;
            truncated.value = false;
            rotated.value = false;
        });

        return {
            text, error, paused, autoScroll, loading, truncated, rotated,
            lastUpdated, logViewport, togglePaused, clearDisplay,
        };
    },
    template: `
        <div class="logs-page">
            <div class="config-page-header">
                <h2>运行日志</h2>
                <router-link to="/dashboard">返回仪表盘</router-link>
            </div>
            <el-card shadow="hover">
                <template #header>
                    <div class="card-header-row">
                        <span role="status">{{ paused ? '已暂停刷新' : (error ? '连接异常，自动重试中' : '每 2 秒增量刷新') }}</span>
                        <div class="log-actions">
                            <el-switch v-model="autoScroll" active-text="自动滚动" />
                            <el-button size="small" @click="togglePaused">{{ paused ? '继续刷新' : '暂停刷新' }}</el-button>
                            <el-button size="small" @click="clearDisplay">清空当前显示</el-button>
                        </div>
                    </div>
                </template>
                <el-alert v-if="error" class="page-alert" type="error" show-icon :closable="false"
                    :title="error" :description="paused ? '已暂停；继续刷新后将重试。' : '每 2 秒自动重试，连接恢复后继续读取。'" />
                <p class="field-help log-help">首次读取历史尾部，仅在本页保留最近 20 万字符。清空只影响当前显示，不会删除服务器日志。</p>
                <p class="field-help log-help" role="status">
                    {{ lastUpdated ? '最后更新：' + lastUpdated : '尚未更新' }}
                    <span v-if="truncated"> · 较早内容已从本页缓存移除</span>
                    <span v-if="rotated"> · 日志已轮转，正在显示新文件</span>
                </p>
                <pre ref="logViewport" class="log-output" tabindex="0" role="region" aria-label="运行日志内容">{{ text || (loading ? '正在读取日志…' : '当前显示为空') }}</pre>
            </el-card>
        </div>
    `,
});