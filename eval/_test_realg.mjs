// 走真实 server 的批改主流程（gradeAssignment），定位「模型返回为空」根因
import { gradeAssignment } from '../lib/grading/pipeline.js';
import { listAssignments } from '../lib/store/memory.js';
import { currentMode } from '../lib/grading/llm.js';

console.log('mode:', currentMode());
const a = listAssignments().find((x) => x.id === 'A1');
console.log('A1 hasKey:', !!(a?.answerKey?.text), '| key:', a?.answerKey?.text?.slice(0, 40));
const text = `def binary_search(arr, target):
    if not arr: return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target: return mid
        elif arr[mid] < target: left = mid + 1
        else: right = mid - 1
    return -1
# O(log n)`;
const t0 = Date.now();
try {
  const r = await gradeAssignment({ assignment: a, studentText: text });
  console.log(`OK ${((Date.now() - t0) / 1000).toFixed(1)}s | mode=${r.mode} score=${r.total_score} dims=${r.dimensions.length} key_match=${r.key_match}`);
  console.log('comment:', r.comment?.slice(0, 60));
} catch (e) {
  console.log(`FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s | ${String(e.message || e).slice(0, 200)}`);
}
