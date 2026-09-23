import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useReplayStore, installReplayRecorder } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const ro = useRepairStore()
const rp = useReplayStore()
installReplayRecorder()
cmd.loadScenario('s1')
tr.load()
rb.load()
ro.load()
rp.setTestClock(9 * 3600 * 1000)
rp.begin()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events.find((e) => e.id === 'ev-001')
const base2 = () => cmd.bases.find((b) => b.id === 'rb-2')
const ROOT = 'b-root'
const foodAt = (snap) => snap.cmd.bases.find((b) => b.id === 'rb-2').stock.food

console.log('— 主干推演：食品派发→签收/短缺→补派（主干三帧） —')
const food0 = foodAt(rp.currentFrame.snapshot)
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
cmd.signDispatch(rec.id, { qty: 80, shortQty: 20, receiver: '李队长' })
cmd.replenishShortage(rec.id)
const rootLen = rp.frameCount
assert(rootLen === 4, `主干录制基线+3 帧（实际 ${rootLen}）`)
const rootTipFood = base2().stock.food
const forkIdx = 1 // 在「食品派发 100」帧分叉：此时尚未签收/补派

console.log('— 分叉 A：保留主干，新分支独立改派饮用水 —')
rp.enterReview(0)
rp.seek(forkIdx)
const fa = rp.resumeHere('方案A·改饮水')
assert(fa.ok && fa.branchId, '分叉返回新分支 id')
const A = fa.branchId
assert(rp.currentBranchId === A, '当前分支切到 A')
assert(rp.frameCount === forkIdx + 1, `A 分支时间轴仅含前缀（${rp.frameCount} === ${forkIdx + 1}）`)
assert(rp.currentFrame.fork === true, 'A 分支分叉帧标记 🌿')

// 关键：主干完整保留，未被截断
const rootBranch = rp.branches[ROOT]
assert(rootBranch.frames.length === rootLen, `原演练分支完整保留（主干仍 ${rootBranch.frames.length} 帧，未截断）`)
assert(rootBranch.frames[rootBranch.frames.length - 1].action === 'replenishShortage', '主干末端仍是补派帧（分叉不影响原线）')

// A 分支态势：食品在途 100 未签收
assert(base2().stock.food === food0 - 100, 'A 分叉点库存=食品已出库 100')
assert(cmd.dispatches.find((d) => d.id === rec.id) && dispatchParts(cmd.dispatches.find((d) => d.id === rec.id)).received === 0, 'A 分叉点食品尚未签收')
assert(!cmd.dispatches.find((d) => d.replenishOf === rec.id), 'A 分叉点无补派单（那是主干的未来）')

// A 上独立处置：不补食品，改派水 50，并入住一批人
const water0 = base2().stock.water
const aWater = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 50 })
const cbA = tr.createBatch({ eventId: ev.id, name: 'A方案批次', headcount: 20, vehicleBaseId: 'rb-2', vehicleCount: 1, shelterId: 'sh-1' }).batch
tr.register(cbA.id, 'pickup', { count: 20 })
tr.register(cbA.id, 'checkin', { count: 20 })
assert(base2().stock.water === water0 - 50, 'A 分支水库存扣减 50')
assert(tr.bedMap['sh-1'].inHouse === 20, 'A 分支 sh-1 在住 20')
const aLen = rp.frameCount
assert(aLen === forkIdx + 5, `A 分支独立新增 4 帧（水派发/建批/接运/入住，实际 ${aLen}）`)

console.log('— 切回主干：态势/库存/床位/派发/抢修整体还原为主干末端 —')
const back = rp.switchBranch(ROOT)
assert(back.ok, '切换回主干成功')
assert(rp.currentBranchId === ROOT && rp.frameCount === rootLen, `主干视图恢复（${rp.frameCount} === ${rootLen}）`)
assert(base2().stock.food === rootTipFood, '主干库存还原（含补派出库，与 A 分支独立）')
assert(base2().stock.water === water0, '主干水库存未受 A 分支派发影响（仍为初始值）')
const rootRec = cmd.dispatches.find((d) => d.id === rec.id)
assert(rootRec && dispatchParts(rootRec).received === 80, '主干食品已签收 80（A 分支的未签收不影响主干）')
assert(!!cmd.dispatches.find((d) => d.replenishOf === rec.id), '主干补派单仍在')
assert(tr.batches.find((b) => b.id === cbA.id) == null, "主干不存在 A 分支的批次（各分支转移状态独立）")
assert(tr.bedMap['sh-1'].inHouse === 0, '主干 sh-1 在住为 0（A 的入住不穿透主干）')

console.log('— 在主干上继续推演（原线可续写，A 分支冻结不受影响） —')
cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 30 })
assert(rp.branches[ROOT].frames.length === rootLen + 1, `主干新增 1 帧（${rp.branches[ROOT].frames.length}）`)
assert(rp.branches[A].frames.length === aLen, `A 分支帧数冻结不变（${rp.branches[A].frames.length} === ${aLen}）`)

console.log('— 从主干末端再分叉 B（平行方案）：抢修阻断路线 —')
const beforeBFork = rp.frameCount
const blk = rb.reportBlock({
  name: '测试断道',
  polygon: [[104.6, 31.5], [104.9, 31.5], [104.9, 31.8], [104.6, 31.8]]
}).block
const order = ro.createOrder({ blockId: blk.id, baseId: 'rb-1', personnel: 6, vehicles: 1, materials: [{ type: 'water', qty: 10 }] }).order
ro.acceptOrder(order.id)
const fb = rp.resumeHere('方案B·强抢修')
const B = fb.branchId
assert(B && B !== A && B !== ROOT, 'B 是又一条独立分支')
assert(rp.branches[A].frames.length === aLen, '分叉 B 不影响 A 分支')
assert(ro.orders.find((o) => o.id === order.id)?.status === 'accepted', 'B 分叉点携带抢修中工单')

// B 推进抢修到完工验收
ro.reportProgress(order.id, { progress: 100 })
ro.finishOrder(order.id, { personnelUsed: 6, vehiclesUsed: 1, materialsUsed: [{ type: 'water', qty: 8 }] })
ro.acceptWork(order.id)
assert(ro.orders.find((o) => o.id === order.id)?.status === 'cleared', 'B 分支工单已办结')
assert(rb.blocks.find((x) => x.id === blk.id)?.status === 'cleared', 'B 分支阻断已解除')

// A 分支没有任何阻断/工单（独立抢修状态）
rp.switchBranch(A)
assert(rb.blocks.find((x) => x.id === blk.id) == null, '切到 A：不存在 B 的阻断（抢修状态独立）')
assert(ro.orders.find((o) => o.id === order.id) == null, '切到 A：不存在 B 的抢修工单')

console.log('— 分支树 / 血缘 —')
const names = rp.branchList.map((b) => b.name)
assert(names.includes('主干推演') && names.includes('方案A·改饮水') && names.includes('方案B·强抢修'), '分支列表含三条线')
const tree = rp.branchTree
assert(tree.length === 1 && tree[0].id === ROOT && tree[0].children.length === 2, '分支树：主干挂 A、B 两个子分支')
// 嵌套分叉：从 A 再分叉 A1
rp.switchBranch(A)
const fA1 = rp.resumeHere('方案A1·加码饮水')
const A1 = fA1.branchId
assert(JSON.stringify(rp.lineage) === JSON.stringify([ROOT, A, A1]), `A1 血缘链正确：${rp.lineage.join(' → ')}`)
assert(rp.branchList.find((b) => b.id === A1).depth === 2, 'A1 深度为 2')
assert(rp.branches[A].frames.length === aLen, '从 A 分叉 A1 后 A 原线保留不变')
assert(rp.branches[A1].frames.length === rp.branches[A].frames.length, 'A1 继承 A 全量前缀帧')

console.log('— 分支末端处置结果对照 —')
rp.toggleCompare(A)
rp.toggleCompare(B)
assert(JSON.stringify(rp.comparePair) === JSON.stringify([A, B]), '选中 A/B 为对照对')
const cmp = rp.compareResult
assert(!!cmp && cmp.rows.length === 12, '对照输出 12 项指标')
const row = (k) => cmp.rows.find((r) => r.key === k)
assert(row('inHouse').a === 20 && row('inHouse').b === 0, '在住安置对照：A=20 / B=0')
assert(row('orders').a === 0 && row('orders').b === 1, '抢修工单对照：A=0 / B=1')
assert(row('blocks').b === 0, 'B 阻断已解除=0')
// 汇总与各分支末端快照一致（独立快照重算）
const list = Object.fromEntries(rp.branchList.map((b) => [b.id, b.summary]))
assert(list[A].dispatches >= 2 && list[ROOT].dispatches >= 3, `派发数对照：A=${list[A].dispatches} 主干=${list[ROOT].dispatches}`)
rp.toggleCompare(A) // 再点 A 取消
assert(rp.comparePair[0] === null && rp.comparePair[1] === B, '取消 A 后槽位置空、B 保留')

console.log('— 只读查看别的分支不影响当前活分支 —')
rp.switchBranch(A1)
const liveTip = rp.frameCount
const view = rp.switchBranch(ROOT, { asReview: true })
assert(view.ok && rp.mode === 'review', '以复盘只读方式查看主干')
assert(rp.currentBranchId === ROOT && rp.frameCount === beforeBFork + 3, '查看的是主干（含阻断/派单帧）')
// 只读期间业务动作拦截
const n = rp.frameCount
assert(cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 5 }) === null, '只读查看主干时动作被拦截')
assert(rp.frameCount === n, '只读查看不产生帧')

console.log('— 重命名与切回活分支 —')
rp.renameBranch(A1, '方案A1·改饮水100箱')
assert(rp.branches[A1].name === '方案A1·改饮水100箱', '分支重命名生效')
rp.switchBranch(A1)
assert(rp.mode === 'live' && rp.currentBranchId === A1, '切回 A1 继续 live 推演')
const cont = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 50 })
assert(!!cont && rp.branches[A1].frames.length === liveTip + 1, 'A1 续写独立成帧')
assert(rp.branches[ROOT].frames.length === beforeBFork + 3 && rp.branches[A].frames.length === aLen, '续写 A1 不影响主干与 A')

console.log('— 单线历史兼容：begin 重置分支树 —')
rp.begin()
assert(rp.branchOrder.length === 1 && rp.currentBranchId === ROOT, '重置后只剩主干')
assert(rp.frameCount === 1 && rp.frames[0].seq === 0, '重置后仅基线帧（旧单线行为）')

if (failed) {
  console.error(`\n❌ 多分支演练复盘测试 ${failed} 项失败`)
  process.exit(1)
} else {
  console.log('\n✅ 多分支演练复盘全部通过：原演练分支保留/分叉不截断/分支切换续演/库存床位派发改抢修各分支独立/嵌套分支树/末端结果对照/只读查看/单线历史兼容')
}
