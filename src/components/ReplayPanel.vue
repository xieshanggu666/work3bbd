<template>
  <Teleport to="body">
    <!-- 复盘回放锁定横幅（面板关闭后仍可见，保证可返回） -->
    <div v-if="replay.mode === 'review'" class="replay-lockbar">
      <span class="lb-dot"></span>
      <strong>复盘回放中 · 演练态势只读</strong>
      <em class="lb-branch">🌿 {{ replay.currentBranch?.name || '演练分支' }}</em>
      <em>{{ replay.currentFrame?.at }} · 节点 {{ replay.cursor + 1 }}/{{ replay.frameCount }}</em>
      <button class="lb-btn" @click="replay.openPanel()">📼 查看时间轴</button>
      <button class="lb-btn fork" @click="onFork">🌿 从此节点分叉新分支</button>
      <button class="lb-btn live" @click="replay.exitToLive()">⏭ 回到本分支末端</button>
    </div>

    <transition name="rp-slide">
      <section v-if="replay.panelOpen" class="replay-drawer">
        <header class="rp-head">
          <div class="rp-title">
            <span class="rp-icon">📼</span>
            <div>
              <h2>历史复盘 · 演练时间轴</h2>
              <p>事件 / 派发 / 转移 / 阻断 / 抢修全程留痕，逐节点回放与分叉恢复</p>
            </div>
          </div>
          <button class="rp-close" @click="replay.closePanel()">✕</button>
        </header>

        <!-- 播放控制条 -->
        <div class="rp-controls">
          <div class="rp-transport">
            <button title="回到首帧" @click="replay.first()">⏮</button>
            <button title="上一节点" @click="replay.prev()">◀</button>
            <button class="rp-play" @click="replay.playing ? replay.pause() : replay.play()">
              {{ replay.playing ? '⏸' : '▶' }}
            </button>
            <button title="下一节点" @click="replay.next()">▶</button>
            <button title="跳到最新" @click="replay.last()">⏭</button>
          </div>
          <input
            class="rp-scrub"
            type="range"
            min="0"
            :max="Math.max(0, replay.frameCount - 1)"
            :value="replay.cursor"
            @input="onScrub"
          />
          <div class="rp-position">
            <strong>{{ replay.cursor + 1 }}</strong> / {{ replay.frameCount }}
            <span class="rp-clock">{{ replay.currentFrame?.at }}</span>
          </div>
          <div class="rp-speed">
            <button
              v-for="s in [1, 2, 4]"
              :key="s"
              :class="{ on: replay.speed === s }"
              @click="replay.setSpeed(s)"
            >{{ s }}×</button>
          </div>
        </div>

        <!-- 分类筛选 -->
        <div class="rp-filters">
          <button :class="{ on: replay.filterCat === 'all' }" @click="replay.setFilter('all')">
            全部 {{ replay.frameCount }}
          </button>
          <button
            v-for="(meta, key) in replay.categoryMeta"
            :key="key"
            :class="{ on: replay.filterCat === key }"
            @click="replay.setFilter(key)"
          >
            <span>{{ meta.icon }}</span>{{ meta.label }}
          </button>
        </div>

        <!-- 多分支管理条 -->
        <div class="rp-branches">
          <div class="br-head">
            <span class="br-title">🌿 演练分支（{{ replay.branchList.length }}）</span>
            <div class="br-tabs">
              <button :class="{ on: tab === 'timeline' }" @click="tab = 'timeline'">🕒 时间轴</button>
              <button
                :class="{ on: tab === 'compare' }"
                :disabled="!compare"
                @click="tab = 'compare'"
              >⚖ 分支对照<span v-if="compareSelCount" class="br-tab-n">{{ compareSelCount }}</span></button>
            </div>
          </div>
          <div class="br-tree">
            <template v-for="node in replay.branchTree" :key="node.id">
              <BranchRow
                :node="node"
                :compare-pair="replay.comparePair"
                :editing-id="editingId"
                @continue="onContinue"
                @view="onView"
                @toggle-compare="replay.toggleCompare($event)"
                @start-rename="editingId = $event"
                @submit-rename="onRename"
              />
            </template>
          </div>
          <div v-if="replay.comparePair[0] || replay.comparePair[1]" class="br-compare-hint">
            已选 {{ compareSelCount }}/2 条分支用于对照
            <button v-if="compare" class="br-go-compare" @click="tab = 'compare'">查看对照 →</button>
            <button class="br-clear" @click="replay.clearCompare()">清空</button>
          </div>
        </div>

        <!-- 时间轴主体 -->
        <div class="rp-body" v-if="tab === 'timeline'">
          <!-- 左：时间轴节点列表 -->
          <div class="rp-timeline">
            <div
              v-for="f in replay.visibleFrames"
              :key="(f.branchId || 'root') + '-' + f.index"
              class="rp-node"
              :class="{ active: f.index === replay.cursor, baseline: f.seq === 0, fork: f.fork }"
              @click="onSelect(f.index)"
            >
              <div class="node-marker" :style="{ background: replay.categoryMeta[f.category].color }">
                {{ f.seq === 0 ? '🎬' : replay.categoryMeta[f.category].icon }}
              </div>
              <div class="node-body">
                <div class="node-line">
                  <span class="node-at">{{ f.at }}</span>
                  <span class="node-cat" :style="{ color: replay.categoryMeta[f.category].color }">
                    {{ replay.categoryMeta[f.category].label }}
                  </span>
                  <span v-if="f.fork" class="node-fork">🌿 分叉点</span>
                </div>
                <div class="node-title">{{ f.title }}</div>
                <div v-if="f.logs.length" class="node-logcount">📝 {{ f.logs.length }} 条处置日志</div>
              </div>
            </div>
            <div v-if="!replay.visibleFrames.length" class="rp-empty">该分类暂无节点</div>
          </div>

          <!-- 右：选中节点复盘详情 -->
          <div class="rp-detail" v-if="replay.currentFrame">
            <div class="detail-head">
              <span
                class="detail-badge"
                :style="{ background: replay.categoryMeta[replay.currentFrame.category].color }"
              >{{ replay.categoryMeta[replay.currentFrame.category].icon }}
                {{ replay.categoryMeta[replay.currentFrame.category].label }}</span>
              <h3>{{ replay.currentFrame.title }}</h3>
              <span class="detail-time">🕐 {{ replay.currentFrame.at }} · 节点 #{{ replay.currentFrame.seq }}</span>
            </div>

            <!-- 态势计数 -->
            <div class="detail-counters" v-if="diff">
              <div class="counter"><strong>{{ diff.counters.events }}</strong><span>事件</span></div>
              <div class="counter"><strong>{{ diff.counters.dispatches }}</strong><span>派发记录</span></div>
              <div class="counter"><strong>{{ diff.counters.batches }}</strong><span>转移批次</span></div>
              <div class="counter"><strong>{{ diff.counters.blocks }}</strong><span>生效阻断</span></div>
              <div class="counter"><strong>{{ diff.counters.orders }}</strong><span>抢修工单</span></div>
              <div class="counter"><strong>第{{ diff.counters.settleDay }}日</strong><span>补给结算</span></div>
            </div>

            <div class="detail-grid">
              <!-- 状态变化 -->
              <div class="detail-card">
                <h4>🔁 状态变化</h4>
                <ul v-if="diff.statusChanges.length">
                  <li v-for="(x, i) in diff.statusChanges" :key="'s'+i">
                    <span :style="{ color: x.color }">{{ x.icon }}</span>{{ x.text }}
                  </li>
                </ul>
                <ul v-else-if="baseline.length">
                  <li v-for="(x, i) in baseline" :key="'b'+i">
                    <span :style="{ color: x.color }">{{ x.icon }}</span>{{ x.text }}
                  </li>
                </ul>
                <p v-else class="dim">本节点无状态变化</p>
              </div>

              <!-- 路线调整 -->
              <div class="detail-card">
                <h4>🗺️ 路线调整</h4>
                <ul v-if="diff.routes.length">
                  <li v-for="(r, i) in diff.routes" :key="'r'+i">
                    <div class="route-line">
                      <span :style="{ color: r.color }">🛣️</span>
                      <strong>{{ r.name }}</strong>
                      <em class="route-kind">{{ r.kind }}</em>
                    </div>
                    <div class="route-metrics" v-if="r.from">
                      <span :class="{ up: r.to.minutes > (r.from.minutes || 0) }">
                        {{ r.from.distance ?? '-' }}km·{{ r.from.minutes ?? '-' }}min
                        → {{ r.to.distance }}km·{{ r.to.minutes }}min
                      </span>
                      <span v-if="r.to.base !== r.from.base">出发/到达点：{{ r.from.base || '—' }} → {{ r.to.base }}</span>
                      <span>途经点 {{ r.from.via || 0 }} → {{ r.to.via }}</span>
                    </div>
                    <div class="route-metrics" v-else>
                      <span>{{ r.to.distance }}km · {{ r.to.minutes }}min · 途经点 {{ r.to.via }}</span>
                    </div>
                  </li>
                </ul>
                <p v-else class="dim">本节点无路线调整</p>
              </div>

              <!-- 资源占用 -->
              <div class="detail-card">
                <h4>🏗️ 资源占用（基地库存）</h4>
                <ul v-if="diff.stocks.length">
                  <li v-for="(x, i) in diff.stocks" :key="'k'+i">
                    <span>📦</span>{{ x.base }} · {{ x.type }}
                    <em class="num" :class="x.delta < 0 ? 'down' : 'up'">
                      {{ x.from }} → {{ x.to }}{{ x.unit }}
                      （{{ x.delta > 0 ? '+' : '' }}{{ x.delta }}）
                    </em>
                  </li>
                </ul>
                <p v-else class="dim">本节点无库存变动</p>

                <h4 class="mt">🏕️ 安置点占用（在住/床位）</h4>
                <ul v-if="diff.occupancy.length">
                  <li v-for="(x, i) in diff.occupancy" :key="'o'+i">
                    <span>🛏️</span>{{ x.shelter }}
                    <em class="num" :class="x.delta < 0 ? 'down' : 'up'">
                      {{ x.from }} → {{ x.to }} / {{ x.capacity }}
                      （{{ x.delta > 0 ? '+' : '' }}{{ x.delta }}）
                    </em>
                  </li>
                </ul>
                <p v-else class="dim">本节点无床位占用变动</p>
              </div>

              <!-- 处置日志 -->
              <div class="detail-card">
                <h4>📝 处置日志</h4>
                <ul class="log-list" v-if="logs.length">
                  <li v-for="(l, i) in logs" :key="'l'+i">
                    <div class="log-head">
                      <span class="log-src" :class="l.source">{{ logSourceLabel(l.source) }}</span>
                      <span class="log-tag">{{ l.tag }}</span>
                      <span class="log-at">{{ l.at }}</span>
                    </div>
                    <div class="log-text">{{ l.text }}</div>
                  </li>
                </ul>
                <p v-else-if="replay.currentFrame.seq === 0" class="dim">演练基线节点，后续每个动作产生的事件时间线、阻断处置日志与抢修工单日志都会在此汇总。</p>
                <p v-else class="dim">本节点无新增处置日志</p>
              </div>
            </div>

            <!-- 节点操作 -->
            <div class="detail-actions">
              <button class="act-fork" @click="onFork">
                🌿 从此节点分叉新分支
                <small>保留当前演练分支完整历史，从本节点另起一支独立推演（库存/床位/派发/抢修各自维护）</small>
              </button>
              <button class="act-live" @click="replay.exitToLive()">⏭ 回到本分支末端</button>
            </div>
          </div>
        </div>

        <!-- 分支对照主体 -->
        <div class="rp-body" v-else-if="tab === 'compare' && compare">
          <div class="compare-wrap">
            <div class="compare-head">
              <div class="compare-side" :style="{ borderColor: compare.a.color }">
                <span class="cs-dot" :style="{ background: compare.a.color }"></span>
                <strong>{{ compare.a.name }}</strong>
                <em>{{ compare.a.frameCount }} 节点 · {{ compare.a.tipAt || '基线' }}</em>
              </div>
              <div class="compare-vs">VS</div>
              <div class="compare-side right" :style="{ borderColor: compare.b.color }">
                <span class="cs-dot" :style="{ background: compare.b.color }"></span>
                <strong>{{ compare.b.name }}</strong>
                <em>{{ compare.b.frameCount }} 节点 · {{ compare.b.tipAt || '基线' }}</em>
              </div>
            </div>

            <table class="compare-table">
              <thead>
                <tr><th>处置结果指标</th><th>{{ compare.a.name }}</th><th>差异(B−A)</th><th>{{ compare.b.name }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in compare.rows" :key="r.key" :class="{ diff: !r.same }">
                  <td class="cm-label">{{ r.label }}</td>
                  <td class="cm-a">{{ r.a }}</td>
                  <td class="cm-d" :class="r.diff > 0 ? 'up' : r.diff < 0 ? 'down' : ''">
                    {{ r.same ? '—' : (r.diff > 0 ? '+' : '') + r.diff }}
                  </td>
                  <td class="cm-b">{{ r.b }}</td>
                </tr>
              </tbody>
            </table>
            <p class="compare-note">
              指标取各分支末端快照独立重算：库存合计、床位在住、派发四本账（累计签收/待补短缺）、转移人数、生效阻断与抢修工单均互不影响。
            </p>
          </div>
        </div>
      </section>
    </transition>
  </Teleport>
</template>

<script setup>
import { computed, h, ref } from 'vue'
import { useReplayStore } from '@/store/replay'

const replay = useReplayStore()

const diff = computed(() => replay.currentDiff)
const logs = computed(() => replay.currentLogs)
const baseline = computed(() => replay.baselineItems)

const tab = ref('timeline')
const editingId = ref(null)

const compare = computed(() => replay.compareResult)
const compareSelCount = computed(() => replay.comparePair.filter(Boolean).length)

function onScrub(e) {
  replay.pause()
  replay.seek(Number(e.target.value))
}
function onSelect(i) {
  replay.pause()
  replay.seek(i)
}
function logSourceLabel(s) {
  return { event: '事件时间线', block: '阻断处置', repair: '抢修工单' }[s] || s
}

// 分叉：保留原线、另起一支。分叉后关闭抽屉进入可操作态势。
function onFork() {
  const r = replay.resumeHere()
  if (r?.ok) tab.value = 'timeline'
}
// 切到该分支末端继续 live 推演
function onContinue(id) {
  replay.switchBranch(id)
}
// 以只读复盘方式查看该分支末端（不改变当前活分支）
function onView(id) {
  replay.switchBranch(id, { asReview: true })
}
function onRename(id, name) {
  replay.renameBranch(id, name)
  editingId.value = null
}

/* 分支树的一行（含子分支递归）。用渲染函数以模板内联，避免再开单文件组件。 */
const BranchRow = {
  name: 'BranchRow',
  props: {
    node: { type: Object, required: true },
    comparePair: { type: Array, default: () => [null, null] },
    editingId: { type: String, default: null }
  },
  emits: ['continue', 'view', 'toggle-compare', 'start-rename', 'submit-rename'],
  setup(props, { emit }) {
    const draft = ref(props.node.name)
    const sel = (id) => props.comparePair.includes(id)
    const submit = () => {
      const v = draft.value.trim()
      if (v) emit('submit-rename', props.node.id, v)
      draft.value = props.node.name
    }
    return ( ) => h('div', { class: 'br-row-wrap' }, [
      h('div', {
        class: ['br-row', { current: props.node.current }],
        style: { marginLeft: props.node.depth * 16 + 'px' }
      }, [
        h('span', { class: 'br-rail', style: { background: props.node.color } }),
        h('div', { class: 'br-main' }, [
          props.editingId === props.node.id
            ? h('input', {
                class: 'br-name-input',
                value: draft.value,
                autofocus: true,
                onClick: (e) => e.stopPropagation(),
                onInput: (e) => { draft.value = e.target.value },
                onKeydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') emit('start-rename', null) },
                onBlur: submit
              })
            : h('div', { class: 'br-line' }, [
                h('span', { class: 'br-name' },
                  (props.node.root ? '🌲 ' : '🌿 ') + props.node.name),
                props.node.current ? h('span', { class: 'br-now' }, '当前') : null,
                h('span', { class: 'br-meta' },
                  `${props.node.frameCount} 节点 · 自有 ${props.node.ownFrameCount} · ${props.node.tipAt || '基线'}`)
              ]),
          h('div', { class: 'br-ops' }, [
            h('button', {
              class: ['op', 'go', { on: props.node.current }],
              title: '切换到该分支末端继续推演',
              disabled: props.node.current,
              onClick: (e) => { e.stopPropagation(); emit('continue', props.node.id) }
            }, '▶ 续演'),
            h('button', {
              class: 'op view',
              title: '只读查看该分支末端',
              onClick: (e) => { e.stopPropagation(); emit('view', props.node.id) }
            }, '👁 查看'),
            h('button', {
              class: ['op', 'cmp', { on: sel(props.node.id) }],
              title: '加入分支对照（最多 2 条）',
              onClick: (e) => { e.stopPropagation(); emit('toggle-compare', props.node.id) }
            }, sel(props.node.id) ? '✓ 对照中' : '⚖ 对照'),
            h('button', {
              class: 'op ren',
              title: '重命名分支',
              onClick: (e) => { e.stopPropagation(); draft.value = props.node.name; emit('start-rename', props.node.id) }
            }, '✎')
          ])
        ])
      ]),
      ...(props.node.children || []).map((ch) =>
        h(BranchRow, {
          key: ch.id,
          node: ch,
          comparePair: props.comparePair,
          editingId: props.editingId,
          onContinue: (id) => emit('continue', id),
          onView: (id) => emit('view', id),
          onToggleCompare: (id) => emit('toggle-compare', id),
          onStartRename: (id) => emit('start-rename', id),
          onSubmitRename: (id, name) => emit('submit-rename', id, name)
        })
      )
    ])
  }
}
</script>

<style scoped>
/* 锁定横幅 */
.replay-lockbar {
  position: fixed;
  top: 74px; left: 50%; transform: translateX(-50%);
  z-index: 2000;
  display: flex; align-items: center; gap: 12px;
  background: linear-gradient(90deg, rgba(120,28,28,0.96), rgba(154,52,18,0.96));
  border: 1px solid rgba(255,180,120,0.45);
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
  border-radius: 10px; padding: 8px 14px;
  color: #ffe9d6; font-size: 12px;
  backdrop-filter: blur(6px);
}
.replay-lockbar strong { color: #fff; font-size: 12px; }
.replay-lockbar em { font-style: normal; color: #ffc9a0; font-size: 11px; }
.lb-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: #ff8a65; animation: lbPulse 1.2s ease-in-out infinite;
}
@keyframes lbPulse { 50% { opacity: 0.35; } }
.lb-btn {
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
  color: #fff; font-size: 11px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
}
.lb-btn:hover { background: rgba(255,255,255,0.22); }
.lb-btn.fork { background: rgba(205,120,40,0.55); border-color: rgba(255,200,140,0.6); }
.lb-btn.live { background: rgba(46,125,50,0.55); border-color: rgba(150,230,160,0.6); }

/* 抽屉 */
.replay-drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(940px, 92vw);
  z-index: 2100;
  background: #0b1428;
  border-left: 1px solid rgba(120,160,220,0.25);
  box-shadow: -12px 0 40px rgba(0,0,0,0.55);
  display: flex; flex-direction: column;
}
.rp-slide-enter-active, .rp-slide-leave-active { transition: transform 0.25s ease; }
.rp-slide-enter-from, .rp-slide-leave-to { transform: translateX(100%); }

.rp-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 14px 18px 10px;
  border-bottom: 1px solid rgba(120,160,220,0.15);
}
.rp-title { display: flex; gap: 12px; align-items: center; }
.rp-icon {
  width: 40px; height: 40px; border-radius: 10px;
  display: grid; place-items: center; font-size: 20px;
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  box-shadow: 0 3px 12px rgba(41,98,255,0.45);
}
.rp-title h2 { margin: 0; font-size: 15px; color: #fff; }
.rp-title p { margin: 2px 0 0; font-size: 11px; color: #6f84ab; }
.rp-close {
  background: transparent; border: none; color: #8ea1c4;
  font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px;
}
.rp-close:hover { background: rgba(255,255,255,0.08); color: #fff; }

/* 控制条 */
.rp-controls {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(120,160,220,0.12);
}
.rp-transport { display: flex; gap: 4px; }
.rp-transport button {
  width: 30px; height: 30px; border-radius: 7px;
  background: #14223d; border: 1px solid rgba(120,160,220,0.2);
  color: #bcd0ee; cursor: pointer; font-size: 12px;
}
.rp-transport button:hover { border-color: #4d8dff; color: #fff; }
.rp-transport .rp-play {
  width: 38px; background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; border-color: transparent;
}
.rp-scrub { flex: 1; accent-color: #4d8dff; cursor: pointer; }
.rp-position {
  font-size: 12px; color: #9db1d4; min-width: 96px; text-align: right;
  font-variant-numeric: tabular-nums;
}
.rp-position strong { color: #fff; font-size: 14px; }
.rp-clock { display: block; color: #7ef0c9; font-family: Consolas, monospace; font-size: 11px; }
.rp-speed { display: flex; gap: 3px; }
.rp-speed button {
  background: transparent; border: 1px solid rgba(120,160,220,0.25);
  color: #8ea1c4; font-size: 11px; border-radius: 6px; padding: 4px 8px; cursor: pointer;
}
.rp-speed button.on { background: rgba(77,141,255,0.25); border-color: #4d8dff; color: #fff; }

/* 筛选 */
.rp-filters {
  display: flex; gap: 6px; flex-wrap: wrap;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(120,160,220,0.12);
}
.rp-filters button {
  background: #101d36; border: 1px solid rgba(120,160,220,0.18);
  color: #9db1d4; font-size: 11px; border-radius: 14px;
  padding: 4px 11px; cursor: pointer;
}
.rp-filters button.on { background: rgba(77,141,255,0.22); border-color: #4d8dff; color: #fff; }

/* 主体两栏 */
.rp-body { flex: 1; display: flex; min-height: 0; }
.rp-timeline {
  width: 320px; flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid rgba(120,160,220,0.12);
  padding: 10px 12px;
}
.rp-node {
  display: flex; gap: 9px;
  padding: 8px 9px; border-radius: 9px;
  cursor: pointer; position: relative;
  border: 1px solid transparent;
}
.rp-node:hover { background: rgba(77,141,255,0.08); }
.rp-node.active { background: rgba(77,141,255,0.16); border-color: rgba(77,141,255,0.5); }
.node-marker {
  width: 26px; height: 26px; flex-shrink: 0;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 12px; color: #fff;
  border: 2px solid rgba(255,255,255,0.25);
}
.rp-node.baseline .node-marker { background: #455a64 !important; }
.node-body { min-width: 0; }
.node-line { display: flex; align-items: center; gap: 7px; }
.node-at { font-size: 10px; color: #6f84ab; font-family: Consolas, monospace; }
.node-cat { font-size: 10px; font-weight: 700; }
.node-fork { font-size: 10px; color: #ffb74d; }
.node-title {
  font-size: 12px; color: #dbe4f3; line-height: 1.45;
  margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.node-logcount { font-size: 10px; color: #7ef0c9; margin-top: 2px; }
.rp-empty { text-align: center; color: #5f739a; font-size: 12px; padding: 30px 0; }

/* 详情 */
.rp-detail {
  flex: 1; overflow-y: auto;
  padding: 14px 18px; min-width: 0;
}
.detail-head { margin-bottom: 10px; }
.detail-badge {
  display: inline-block; color: #fff; font-size: 10px;
  padding: 2px 9px; border-radius: 10px; margin-bottom: 6px;
}
.detail-head h3 { margin: 0 0 3px; font-size: 15px; color: #fff; line-height: 1.4; }
.detail-time { font-size: 11px; color: #7ef0c9; font-family: Consolas, monospace; }

.detail-counters {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 7px;
  margin-bottom: 12px;
}
.counter {
  background: #101d36; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 8px; padding: 7px 4px; text-align: center;
}
.counter strong { display: block; font-size: 14px; color: #fff; }
.counter span { font-size: 10px; color: #7d92b6; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.detail-card {
  background: #0e1a32; border: 1px solid rgba(120,160,220,0.14);
  border-radius: 10px; padding: 11px 13px;
}
.detail-card h4 { margin: 0 0 8px; font-size: 12px; color: #cdd9ee; }
.detail-card h4.mt { margin-top: 14px; }
.detail-card ul { margin: 0; padding: 0; list-style: none; }
.detail-card li {
  font-size: 12px; color: #aebadd; line-height: 1.55;
  padding: 3px 0; display: flex; gap: 6px; align-items: baseline;
}
.detail-card li > span { flex-shrink: 0; }
.dim { font-size: 11px; color: #5f739a; margin: 0; }
.num { font-style: normal; margin-left: auto; font-variant-numeric: tabular-nums; }
.num.down { color: #7ef0c9; }
.num.up { color: #ff8a65; }

.route-line { display: flex; gap: 6px; align-items: baseline; }
.route-line strong { font-size: 12px; color: #dbe4f3; font-weight: 600; }
.route-kind {
  font-style: normal; font-size: 10px; color: #ffd180;
  background: rgba(255,160,0,0.12); border: 1px solid rgba(255,160,0,0.3);
  border-radius: 4px; padding: 0 5px; margin-left: auto;
}
.route-metrics {
  width: 100%; padding-left: 20px;
  display: flex; flex-direction: column;
  font-size: 11px; color: #8ea1c4; font-variant-numeric: tabular-nums;
}
.route-metrics .up { color: #ff8a65; }

.log-list li {
  flex-direction: column; gap: 2px; align-items: stretch;
  border-left: 2px solid rgba(126,240,201,0.35);
  padding: 4px 0 6px 8px; margin-bottom: 6px;
}
.log-head { display: flex; align-items: center; gap: 7px; }
.log-src {
  font-size: 9px; border-radius: 4px; padding: 1px 6px; color: #fff;
}
.log-src.event { background: #e69100; }
.log-src.block { background: #c62828; }
.log-src.repair { background: #b8860b; }
.log-tag { font-size: 10px; color: #9db1d4; }
.log-at { margin-left: auto; font-size: 10px; color: #6f84ab; font-family: Consolas, monospace; }
.log-text { font-size: 12px; color: #c6d2e6; line-height: 1.5; }

.detail-actions {
  display: flex; gap: 10px; margin-top: 14px;
}
.act-fork {
  flex: 1;
  background: linear-gradient(135deg, #c77828, #e69100);
  border: none; border-radius: 10px; padding: 10px 14px;
  color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
  box-shadow: 0 3px 12px rgba(230,145,0,0.35);
}
.act-fork small { display: block; font-weight: 400; font-size: 10px; opacity: 0.85; margin-top: 2px; }
.act-live {
  background: rgba(46,125,50,0.35); border: 1px solid rgba(150,230,160,0.5);
  border-radius: 10px; padding: 0 16px; color: #b9f6ca;
  font-size: 12px; cursor: pointer;
}

@media (max-width: 1000px) {
  .detail-grid { grid-template-columns: 1fr; }
  .detail-counters { grid-template-columns: repeat(3, 1fr); }
}

/* ===== 多分支管理条 ===== */
.replay-lockbar .lb-branch {
  font-style: normal; color: #b9f6ca; font-size: 11px;
  background: rgba(46,125,50,0.3); border: 1px solid rgba(150,230,160,0.4);
  padding: 2px 8px; border-radius: 10px;
}
.rp-branches {
  border-bottom: 1px solid rgba(120,160,220,0.12);
  padding: 8px 18px 9px;
  max-height: 168px; display: flex; flex-direction: column;
}
.br-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.br-title { font-size: 11px; color: #cdd9ee; font-weight: 700; }
.br-tabs { display: flex; gap: 4px; }
.br-tabs button {
  background: #101d36; border: 1px solid rgba(120,160,220,0.18);
  color: #9db1d4; font-size: 11px; border-radius: 6px; padding: 3px 10px; cursor: pointer;
}
.br-tabs button.on { background: rgba(77,141,255,0.25); border-color: #4d8dff; color: #fff; }
.br-tabs button:disabled { opacity: 0.4; cursor: not-allowed; }
.br-tab-n {
  display: inline-block; margin-left: 4px; min-width: 14px; padding: 0 4px;
  background: #e69100; color: #fff; border-radius: 8px; font-size: 9px;
}
.br-tree { overflow-y: auto; flex: 1; }
.br-row {
  display: flex; align-items: stretch; gap: 0;
  border-radius: 8px; padding: 2px 0;
}
.br-row.current { background: rgba(77,141,255,0.12); }
.br-rail { width: 3px; border-radius: 2px; flex-shrink: 0; margin-right: 8px; }
.br-main { flex: 1; min-width: 0; padding: 3px 4px; }
.br-line { display: flex; align-items: center; gap: 8px; }
.br-name { font-size: 12px; color: #e4ecfa; font-weight: 600; white-space: nowrap; }
.br-now {
  font-size: 9px; color: #b9f6ca; background: rgba(46,125,50,0.4);
  border: 1px solid rgba(150,230,160,0.5); border-radius: 8px; padding: 0 6px;
}
.br-meta { font-size: 10px; color: #6f84ab; margin-left: auto; font-variant-numeric: tabular-nums; }
.br-ops { display: flex; gap: 4px; margin-top: 3px; }
.br-ops .op {
  background: #101d36; border: 1px solid rgba(120,160,220,0.2);
  color: #9db1d4; font-size: 10px; border-radius: 5px; padding: 2px 7px; cursor: pointer;
}
.br-ops .op:hover:not(:disabled) { border-color: #4d8dff; color: #fff; }
.br-ops .op.on { background: rgba(230,145,0,0.3); border-color: #e69100; color: #ffe0b2; }
.br-ops .op.go.on { background: rgba(46,125,50,0.35); border-color: #66bb6a; color: #b9f6ca; }
.br-ops .op:disabled { opacity: 0.5; cursor: default; }
.br-name-input {
  background: #0b1428; border: 1px solid #4d8dff; color: #fff;
  font-size: 12px; border-radius: 5px; padding: 2px 6px; width: 220px; outline: none;
}
.br-compare-hint {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; font-size: 10px; color: #ffd180;
}
.br-go-compare {
  margin-left: auto; background: rgba(230,145,0,0.25); border: 1px solid #e69100;
  color: #ffe0b2; border-radius: 5px; font-size: 10px; padding: 2px 9px; cursor: pointer;
}
.br-clear {
  background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #9db1d4; border-radius: 5px; font-size: 10px; padding: 2px 9px; cursor: pointer;
}

/* ===== 分支对照面板 ===== */
.compare-wrap { padding: 16px 22px; width: 100%; overflow-y: auto; }
.compare-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.compare-side {
  flex: 1; display: flex; flex-direction: column; gap: 3px;
  background: #0e1a32; border-left: 4px solid; border-radius: 10px; padding: 11px 14px;
}
.compare-side.right { text-align: right; }
.compare-side strong { font-size: 14px; color: #fff; }
.compare-side em { font-style: normal; font-size: 11px; color: #7d92b6; font-variant-numeric: tabular-nums; }
.cs-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.compare-vs {
  font-size: 12px; font-weight: 800; color: #ffb74d;
  background: rgba(230,145,0,0.15); border: 1px solid rgba(230,145,0,0.4);
  border-radius: 50%; width: 38px; height: 38px; display: grid; place-items: center; flex-shrink: 0;
}
.compare-table { width: 100%; border-collapse: collapse; }
.compare-table th, .compare-table td {
  padding: 9px 12px; font-size: 12px; text-align: center;
  border-bottom: 1px solid rgba(120,160,220,0.1);
}
.compare-table th { color: #9db1d4; font-size: 11px; background: #0e1a32; position: sticky; top: 0; }
.compare-table td.cm-label { text-align: left; color: #cdd9ee; font-weight: 600; }
.compare-table tr.diff { background: rgba(77,141,255,0.05); }
.cm-a { color: #bcd0ee; font-variant-numeric: tabular-nums; }
.cm-b { color: #bcd0ee; font-variant-numeric: tabular-nums; }
.cm-d { font-variant-numeric: tabular-nums; color: #7d92b6; }
.cm-d.up { color: #7ef0c9; font-weight: 700; }
.cm-d.down { color: #ff8a65; font-weight: 700; }
.compare-note { margin-top: 14px; font-size: 11px; color: #5f739a; line-height: 1.6; }
</style>
